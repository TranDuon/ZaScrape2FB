import { childLogger } from "./logger.js";

const log = childLogger("shutdown");

type ShutdownTask = () => Promise<void> | void;

const tasks: Array<{ name: string; run: ShutdownTask }> = [];
let shuttingDown = false;

/** Đăng ký việc cần làm khi tắt service. Chạy theo thứ tự ngược với lúc đăng ký. */
export function onShutdown(name: string, run: ShutdownTask): void {
    tasks.push({ name, run });
}

export function isShuttingDown(): boolean {
    return shuttingDown;
}

export function installShutdownHandlers(timeoutMs = 30_000): void {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
            void shutdown(signal, timeoutMs);
        });
    }

    process.on("unhandledRejection", (reason) => {
        log.error({ err: reason }, "Promise bị reject mà không được xử lý");
    });
}

async function shutdown(signal: string, timeoutMs: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info({ signal }, "Bắt đầu tắt service");

    // Quá hạn thì thoát cứng: để tiến trình treo mãi còn tệ hơn, các job dở dang
    // sẽ được stale reaper dọn khi khởi động lại.
    const forceExit = setTimeout(() => {
        log.error({ timeout_ms: timeoutMs }, "Hết thời gian chờ, thoát cứng");
        process.exit(1);
    }, timeoutMs);
    forceExit.unref();

    for (const task of [...tasks].reverse()) {
        try {
            await task.run();
            log.debug({ task: task.name }, "Hoàn tất bước tắt");
        } catch (error) {
            log.error({ err: error, task: task.name }, "Lỗi khi tắt");
        }
    }

    clearTimeout(forceExit);
    log.info("Đã tắt hoàn tất");
    process.exit(0);
}
