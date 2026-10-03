import { fork, type ChildProcess } from "node:child_process";
import net from "node:net";
import readline from "node:readline";

/**
 * Giữ agent (src/index.ts) chạy như một tiến trình con của dashboard.
 *
 * Tách tiến trình thay vì chạy agent ngay trong dashboard là cố ý: agent chết (MongoDB chưa có mạng
 * lúc vừa mở máy, lỗi .env, crash giữa chừng) thì dashboard vẫn sống — vẫn xem được log vì sao nó
 * chết và vẫn bấm Chạy lại được. Dashboard mà chết cùng agent thì đúng lúc cần nó nhất lại không có.
 */

export type AgentStatus =
    /** Không chạy, và cũng không định chạy (người dùng bấm Dừng). */
    | "stopped"
    | "running"
    | "stopping"
    /** Vừa chết bất thường, đang chờ hết thời gian lùi rồi tự chạy lại. */
    | "backoff"
    /** Cổng health đã có agent khác giữ (vd một cửa sổ `npm run dev`) — không chạy thêm bản thứ hai. */
    | "external";

export interface AgentLogLine {
    seq: number;
    time: string;
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    module: string | null;
    msg: string;
    /** Các trường còn lại của dòng log pino, rút gọn thành một chuỗi. */
    detail: string | null;
}

export interface AgentSnapshot {
    status: AgentStatus;
    pid: number | null;
    started_at: string | null;
    /** Tổng số lần dashboard tự chạy lại agent sau khi nó chết bất thường. */
    auto_restarts: number;
    next_retry_at: string | null;
    last_exit: { code: number | null; signal: string | null; at: string } | null;
}

export interface CrashInfo {
    code: number | null;
    signal: string | null;
    retryInMs: number;
    /** Lần chết thứ mấy liên tiếp (chưa chạy êm được STABLE_RUN_MS ở giữa). */
    streak: number;
    /** Vài dòng log lỗi cuối cùng trước khi chết. */
    lastErrors: string[];
}

interface SupervisorOptions {
    /**
     * Biến môi trường cho agent. Phải là bản chụp TRƯỚC khi dashboard nạp .env: nếu truyền luôn các
     * giá trị đã nạp thì dotenv bên trong agent (không ghi đè biến có sẵn) sẽ bỏ qua .env mới —
     * sửa .env rồi bấm Chạy lại sẽ chẳng thay đổi gì.
     */
    agentEnv: NodeJS.ProcessEnv;
    healthHost: string;
    healthPort: number;
    onCrash: (info: CrashInfo) => void;
    /** File agent cần chạy. Chỉ đổi khi kiểm thử supervisor bằng agent giả. */
    entry?: string;
}

const LOG_BUFFER_SIZE = 1_500;
/** Chờ agent tự tắt êm. Agent tự thoát cứng sau 30s (utils/shutdown.ts), chừa thêm cho Playwright. */
const GRACEFUL_STOP_MS = 45_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** Chạy êm được chừng này thì lần chết sau tính là sự cố mới, lùi lại từ đầu. */
const STABLE_RUN_MS = 10 * 60_000;
const EXTERNAL_RECHECK_MS = 30_000;

const PINO_LEVELS: Record<number, AgentLogLine["level"]> = {
    10: "trace",
    20: "debug",
    30: "info",
    40: "warn",
    50: "error",
    60: "fatal",
};

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function isPortOpen(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const finish = (open: boolean) => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(2_000, () => finish(false));
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
    });
}

export class AgentSupervisor {
    private child: ChildProcess | null = null;
    private wanted = false;
    private status: AgentStatus = "stopped";
    private startedAt: number | null = null;
    private autoRestarts = 0;
    private crashStreak = 0;
    private lastExit: AgentSnapshot["last_exit"] = null;
    private retryTimer: NodeJS.Timeout | null = null;
    private nextRetryAt: number | null = null;
    private exitWaiters: Array<() => void> = [];
    /** Đang dò cổng trước khi fork — chặn hai lần bấm Chạy liên tiếp mở ra hai agent. */
    private launching = false;

    private readonly logs: AgentLogLine[] = [];
    private seq = 0;

    constructor(private readonly options: SupervisorOptions) {}

    snapshot(): AgentSnapshot {
        return {
            status: this.status,
            pid: this.child?.pid ?? null,
            started_at: this.startedAt ? new Date(this.startedAt).toISOString() : null,
            auto_restarts: this.autoRestarts,
            next_retry_at: this.nextRetryAt ? new Date(this.nextRetryAt).toISOString() : null,
            last_exit: this.lastExit,
        };
    }

    logsAfter(seq: number): AgentLogLine[] {
        return this.logs.filter((line) => line.seq > seq);
    }

    /** Ghi một dòng của chính dashboard vào cùng luồng log, để đọc liền mạch với log agent. */
    note(level: AgentLogLine["level"], msg: string): void {
        this.push({ time: nowLabel(), level, module: "dashboard", msg, detail: null });
    }

    start(): void {
        // Đang tắt dở thì để nó tắt xong; bật cờ lúc này sẽ khiến lần thoát sắp tới bị hiểu là crash.
        if (this.status === "stopping") return;
        this.wanted = true;
        // Bấm Chạy trong lúc đang chờ lùi thì chạy ngay, không bắt người dùng đợi hết giờ.
        if (this.status === "backoff" || this.status === "stopped" || this.status === "external") {
            this.clearRetry();
            this.crashStreak = 0;
            void this.launch();
        }
    }

    async stop(): Promise<void> {
        this.wanted = false;
        this.clearRetry();

        const child = this.child;
        if (!child) {
            this.status = "stopped";
            return;
        }

        this.status = "stopping";
        this.note("info", "Đang dừng agent (chờ agent tự tắt êm)…");

        const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));

        // Tắt êm qua IPC chứ không qua kill(): trên Windows kill() là giết cứng — xem utils/shutdown.ts.
        if (child.connected) child.send("shutdown");
        else child.kill();

        const timeout = setTimeout(() => {
            this.note("error", `Agent không tự tắt sau ${GRACEFUL_STOP_MS / 1000}s — buộc phải giết cứng`);
            child.kill("SIGKILL");
        }, GRACEFUL_STOP_MS);

        await exited;
        clearTimeout(timeout);
    }

    async restart(): Promise<void> {
        await this.stop();
        this.start();
    }

    private clearRetry(): void {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.nextRetryAt = null;
    }

    private scheduleRetry(delayMs: number, status: AgentStatus): void {
        this.clearRetry();
        this.status = status;
        this.nextRetryAt = Date.now() + delayMs;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.nextRetryAt = null;
            void this.launch();
        }, delayMs);
    }

    private async launch(): Promise<void> {
        if (this.child || this.launching || !this.wanted) return;
        this.launching = true;
        try {
            await this.spawnUnlessTaken();
        } finally {
            this.launching = false;
        }
    }

    private async spawnUnlessTaken(): Promise<void> {

        // Có ai đó đang giữ cổng health thì đó là một agent khác đang chạy. Không mở thêm: agent thứ
        // hai sẽ tự dừng vì khoá cổng, nhưng kiểm tra trước thì dashboard báo được rõ tình trạng thay
        // vì quay vòng crash-chạy lại.
        if (await isPortOpen(this.options.healthHost, this.options.healthPort)) {
            if (this.status !== "external") {
                this.note(
                    "warn",
                    `Cổng ${this.options.healthPort} đã có agent khác giữ (có thể là npm run dev) — không chạy thêm bản thứ hai. ` +
                        "Dashboard sẽ tự nhận quản lý khi agent đó tắt.",
                );
            }
            this.scheduleRetry(EXTERNAL_RECHECK_MS, "external");
            return;
        }
        if (this.child || !this.wanted) return;

        const child = fork(this.options.entry ?? "src/index.ts", [], {
            cwd: process.cwd(),
            execArgv: ["--import", "tsx"],
            env: {
                ...this.options.agentEnv,
                // Log JSON thô thay vì pino-pretty: dashboard tự đọc và tô màu theo level.
                LOG_PRETTY: "false",
                // Như deploy/*: thiếu TZ thì mọi phép tính ngày/giờ lệch 7 tiếng trên máy chạy UTC.
                TZ: this.options.agentEnv.TZ ?? "Asia/Ho_Chi_Minh",
            },
            silent: true,
        });

        this.child = child;
        this.status = "running";
        this.startedAt = Date.now();
        this.note("info", `Đã chạy agent (pid ${child.pid ?? "?"})`);

        // PHẢI đọc hết stdout/stderr: dashboard chạy ẩn không có console, ống không ai đọc sẽ đầy
        // và làm agent treo cứng ở lần ghi log tiếp theo.
        readline.createInterface({ input: child.stdout! }).on("line", (line) => this.ingest(line, "info"));
        readline.createInterface({ input: child.stderr! }).on("line", (line) => this.ingest(line, "error"));

        child.once("error", (error) => {
            this.note("error", `Không chạy được agent: ${error.message}`);
        });

        child.once("exit", (code, signal) => this.onExit(child, code, signal));
    }

    private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
        if (this.child !== child) return;

        const ranMs = this.startedAt ? Date.now() - this.startedAt : 0;
        this.child = null;
        this.startedAt = null;
        this.lastExit = { code, signal, at: new Date().toISOString() };

        const waiters = this.exitWaiters.splice(0);
        for (const resolve of waiters) resolve();

        if (!this.wanted) {
            this.status = "stopped";
            this.note("info", `Agent đã dừng (mã thoát ${code ?? signal})`);
            return;
        }

        // Chết khi không ai bảo dừng = sự cố. Lùi dần để không quay vòng liên tục lúc MongoDB/mạng
        // đang hỏng, nhưng chạy êm đủ lâu rồi mới chết thì tính là sự cố mới.
        if (ranMs >= STABLE_RUN_MS) this.crashStreak = 0;
        this.crashStreak += 1;
        this.autoRestarts += 1;

        const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.crashStreak - 1), BACKOFF_MAX_MS);
        this.note(
            "error",
            `Agent dừng bất thường (mã thoát ${code ?? signal}) — tự chạy lại sau ${Math.round(delay / 1000)}s`,
        );

        this.options.onCrash({
            code,
            signal,
            retryInMs: delay,
            streak: this.crashStreak,
            lastErrors: this.logs
                .filter((line) => line.module !== "dashboard" && (line.level === "error" || line.level === "fatal"))
                .slice(-3)
                .map((line) => `${line.msg}${line.detail ? ` — ${line.detail}` : ""}`),
        });

        this.scheduleRetry(delay, "backoff");
    }

    private ingest(raw: string, fallbackLevel: AgentLogLine["level"]): void {
        const text = raw.replace(ANSI_PATTERN, "").trimEnd();
        if (!text) return;

        if (text.startsWith("{")) {
            try {
                const { level, time, msg, module, pid: _pid, hostname: _hostname, ...rest } = JSON.parse(text) as Record<
                    string,
                    unknown
                >;
                this.push({
                    time: typeof time === "string" ? time.slice(11) : nowLabel(),
                    level: PINO_LEVELS[Number(level)] ?? fallbackLevel,
                    module: typeof module === "string" ? module : null,
                    msg: typeof msg === "string" ? msg : "",
                    detail: summarize(rest),
                });
                return;
            } catch {
                // Không phải JSON hợp lệ — rơi xuống ghi nguyên dòng.
            }
        }

        this.push({ time: nowLabel(), level: fallbackLevel, module: null, msg: text, detail: null });
    }

    private push(line: Omit<AgentLogLine, "seq">): void {
        this.seq += 1;
        this.logs.push({ ...line, seq: this.seq });
        if (this.logs.length > LOG_BUFFER_SIZE) this.logs.splice(0, this.logs.length - LOG_BUFFER_SIZE);
    }
}

function nowLabel(): string {
    return new Date().toLocaleTimeString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" });
}

/** Rút gọn các trường phụ của dòng log; lỗi thì chỉ lấy message, stack đầy đủ vẫn nằm trong logs/. */
function summarize(rest: Record<string, unknown>): string | null {
    const err = rest.err as { message?: unknown } | undefined;
    if (err && typeof err === "object") rest.err = err.message;
    if (Object.keys(rest).length === 0) return null;

    const text = JSON.stringify(rest);
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
