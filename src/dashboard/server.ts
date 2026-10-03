import fs from "node:fs/promises";
import http from "node:http";
import { env } from "../config/env.js";
import { closeMongo, connectMongo } from "../db/mongoClient.js";
import { approve, pause, reject, resume, retry } from "../review/reviewFlow.js";
import { childLogger } from "../utils/logger.js";
import { AgentSupervisor, type CrashInfo } from "./agentProcess.js";
import { buildOverview } from "./overview.js";

const log = childLogger("dashboard");

const MONGO_RETRY_MS = 15_000;

let mongoReady = false;
let mongoError: string | null = null;

/**
 * Kết nối MongoDB, thử lại mãi tới khi được. Dashboard chạy lúc vừa mở máy, khi Wi-Fi có thể chưa
 * lên — thiếu MongoDB thì vẫn phải phục vụ được phần quản lý tiến trình và log.
 */
async function connectMongoForever(): Promise<void> {
    for (;;) {
        try {
            await connectMongo();
            mongoReady = true;
            mongoError = null;
            return;
        } catch (error) {
            mongoError = error instanceof Error ? error.message : String(error);
            log.warn({ err: error }, "Dashboard chưa kết nối được MongoDB, sẽ thử lại");
            // connectMongo giữ lại client hỏng khi connect() lỗi — đóng đi để lần sau tạo mới.
            await closeMongo().catch(() => undefined);
            await new Promise((resolve) => setTimeout(resolve, MONGO_RETRY_MS));
        }
    }
}

/**
 * Báo Telegram khi agent chết bất thường, gọi thẳng Bot API.
 *
 * Không dùng `sendNotification` của notifier: nó cần bot đã `start`, mà bật bot ở đây sẽ mở vòng
 * getUpdates thứ hai tranh với agent (Telegram trả 409 cho một trong hai). Gửi tin thì không tranh.
 */
async function notifyCrash(info: CrashInfo): Promise<void> {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
    // Chỉ báo lần chết ĐẦU của một chuỗi. Agent chết lặp lại (.env hỏng, mất mạng) thì cứ mỗi lần
    // chạy lại lại báo một tin — kênh điều khiển thành rác đúng như lý do notifyExtracted chỉ báo tin ready.
    if (info.streak > 1) return;

    const text = [
        "💥 Agent dừng bất thường",
        `Mã thoát: ${info.code ?? info.signal}`,
        `Dashboard tự chạy lại sau ${Math.round(info.retryInMs / 1000)}s. Nếu còn chết tiếp sẽ không báo lại cho tới khi agent chạy êm được 10 phút.`,
        ...(info.lastErrors.length > 0 ? ["", "Lỗi gần nhất:", ...info.lastErrors.map((line) => `• ${line.slice(0, 300)}`)] : []),
        "",
        `Xem log: http://127.0.0.1:${env.DASHBOARD_PORT}`,
    ].join("\n");

    try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
            signal: AbortSignal.timeout(15_000),
        });
    } catch (error) {
        log.warn({ err: error }, "Không gửi được thông báo agent chết qua Telegram");
    }
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
}

/**
 * Chặn trang web lạ điều khiển dashboard qua trình duyệt của chính người dùng.
 *
 * - Host phải là địa chỉ dashboard: chặn DNS rebinding (tên miền lạ trỏ về 127.0.0.1).
 * - Thao tác POST phải mang header riêng: trình duyệt chỉ gửi header tự đặt sang origin khác sau
 *   một preflight CORS, mà dashboard không bao giờ trả lời preflight — nên trang lạ không POST được.
 */
function isTrustedRequest(request: http.IncomingMessage): boolean {
    const allowedHosts = new Set([
        `127.0.0.1:${env.DASHBOARD_PORT}`,
        `localhost:${env.DASHBOARD_PORT}`,
        `${env.DASHBOARD_BIND}:${env.DASHBOARD_PORT}`,
    ]);
    if (!allowedHosts.has(request.headers.host ?? "")) return false;
    if (request.method === "POST" && request.headers["x-dashboard-action"] !== "1") return false;
    return true;
}

export async function startDashboard(agentEnv: NodeJS.ProcessEnv): Promise<void> {
    const html = await fs.readFile(new URL("./ui.html", import.meta.url), "utf8");

    const supervisor = new AgentSupervisor({
        agentEnv,
        healthHost: env.HEALTH_CHECK_BIND,
        healthPort: env.HEALTH_CHECK_PORT,
        onCrash: (info) => void notifyCrash(info),
    });

    const actions: Record<string, (code?: string) => Promise<string>> = {
        "agent/start": async () => {
            supervisor.start();
            return "Đang chạy agent…";
        },
        "agent/stop": async () => {
            await supervisor.stop();
            return "Đã dừng agent.";
        },
        "agent/restart": async () => {
            await supervisor.restart();
            return "Đã khởi động lại agent.";
        },
        // Tắt hẳn dashboard (npm run dashboard:stop gọi vào đây). Trả lời trước rồi mới tắt, để lệnh
        // gọi nhận được phản hồi; việc dừng agent êm diễn ra ngay sau đó.
        "dashboard/quit": async () => {
            setImmediate(() => void shutdown("dashboard/quit"));
            return "Đang dừng agent rồi tắt dashboard…";
        },
        "breaker/pause": () => pause(),
        "breaker/resume": () => resume(),
        approve: (code) => approve(code ?? "", "dashboard"),
        reject: (code) => reject(code ?? "", "dashboard"),
        retry: (code) => retry(code ?? ""),
    };
    const needsMongo = new Set(["breaker/pause", "breaker/resume", "approve", "reject", "retry"]);

    async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        if (!isTrustedRequest(request)) {
            response.writeHead(403).end();
            return;
        }

        const url = new URL(request.url ?? "/", "http://dashboard");

        if (request.method === "GET" && url.pathname === "/") {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            response.end(html);
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/overview") {
            let data: Awaited<ReturnType<typeof buildOverview>> | null = null;
            let error: string | null = mongoReady ? null : `Chưa kết nối MongoDB${mongoError ? `: ${mongoError}` : ""}`;

            if (mongoReady) {
                try {
                    data = await buildOverview();
                } catch (caught) {
                    error = caught instanceof Error ? caught.message : String(caught);
                }
            }

            sendJson(response, 200, { agent: supervisor.snapshot(), data, error });
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/logs") {
            sendJson(response, 200, supervisor.logsAfter(Number(url.searchParams.get("after") ?? 0) || 0));
            return;
        }

        // POST /api/agent/stop | /api/breaker/resume | /api/listings/<mã>/approve …
        const match = /^\/api\/(?:(agent|breaker|dashboard)\/(\w+)|listings\/([0-9a-f]{4,24})\/(\w+))$/i.exec(url.pathname);
        if (request.method === "POST" && match) {
            const key = match[1] ? `${match[1]}/${match[2]}` : (match[4] ?? "");
            const code = match[3];
            const action = actions[key];

            if (!action) {
                sendJson(response, 404, { ok: false, message: `Không có thao tác "${key}"` });
                return;
            }
            if (needsMongo.has(key) && !mongoReady) {
                sendJson(response, 503, { ok: false, message: "Chưa kết nối MongoDB" });
                return;
            }

            const message = await action(code);
            log.info({ action: key, code }, "Thao tác từ dashboard");
            supervisor.note("info", `Dashboard: ${key}${code ? ` ${code}` : ""} → ${message.split("\n")[0]}`);
            sendJson(response, 200, { ok: true, message });
            return;
        }

        response.writeHead(404).end();
    }

    /**
     * Tắt dashboard: dừng agent ÊM trước rồi mới thoát.
     *
     * Thứ tự này bắt buộc trên Windows: libuv đặt mọi tiến trình con vào một job object có
     * KILL_ON_JOB_CLOSE, nên dashboard thoát (hay bị giết) lúc agent còn chạy là agent — cùng Chrome
     * của Playwright — bị giết cứng theo, không kịp đóng trình duyệt hay chốt tin nhắn đang gom.
     */
    let closing = false;

    const server = http.createServer((request, response) => {
        handle(request, response).catch((error) => {
            log.error({ err: error, url: request.url }, "Lỗi xử lý request dashboard");
            if (!response.headersSent) sendJson(response, 500, { ok: false, message: String(error) });
        });
    });

    // Chiếm cổng TRƯỚC khi chạy agent: đây là khoá một-dashboard. Shortcut khởi động cùng Windows
    // chạy lần nữa khi dashboard đã có (vd người dùng tự bấm) thì bản sau thoát luôn, không đẻ agent.
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(env.DASHBOARD_PORT, env.DASHBOARD_BIND, () => {
            server.off("error", reject);
            resolve();
        });
    });

    const url = `http://${env.DASHBOARD_BIND}:${env.DASHBOARD_PORT}`;
    log.info({ url }, "Dashboard đã bật");
    supervisor.note("info", `Dashboard đã bật tại ${url}`);

    void connectMongoForever();

    if (env.DASHBOARD_AUTOSTART_AGENT) supervisor.start();
    else supervisor.note("info", "DASHBOARD_AUTOSTART_AGENT=false — agent chưa chạy, bấm Chạy để bật");

    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(signal, () => void shutdown(signal));
    }

    async function shutdown(signal: string): Promise<void> {
        if (closing) return;
        closing = true;
        log.info({ signal }, "Đang tắt dashboard, dừng agent trước");
        await supervisor.stop();
        server.close();
        await closeMongo().catch(() => undefined);
        process.exit(0);
    }
}
