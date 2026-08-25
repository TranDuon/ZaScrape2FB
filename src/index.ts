import { env } from "./config/env.js";
import { connectMongo, closeMongo } from "./db/mongoClient.js";
import { appState } from "./db/collections.js";
import { ensureAppState, ensureIndexes } from "./db/indexes.js";
import { APP_STATE_ID } from "./config/constants.js";
import { closeBrowser } from "./facebook/fbBrowser.js";
import { startHealthServer, stopHealthServer } from "./health/healthServer.js";
import { startComposerWorker } from "./jobs/composerWorker.js";
import { startExtractionWorker } from "./jobs/extractionWorker.js";
import { requeueStaleJobs } from "./jobs/jobQueue.js";
import { startMaintenanceScheduler, stopMaintenanceScheduler } from "./maintenance/cronJobs.js";
import { notifyStartup, notifyZaloIssue } from "./notifier/notifyEvents.js";
import { sendNotification, startTelegramBot, stopTelegramBot } from "./notifier/telegramBot.js";
import { registerReviewCommands } from "./review/reviewFlow.js";
import { startScheduler, stopScheduler } from "./scheduler/cronRunner.js";
import { logger } from "./utils/logger.js";
import { installShutdownHandlers, isShuttingDown, onShutdown } from "./utils/shutdown.js";
import { MessageListener } from "./zalo/messageListener.js";
import { ReconnectManager } from "./zalo/reconnectManager.js";

/** Đánh dấu Zalo chưa kết nối. Cờ thật sẽ do ReconnectManager bật lên khi kết nối xong. */
async function markZaloDisconnected(): Promise<void> {
    await appState().updateOne(
        { _id: APP_STATE_ID },
        { $set: { "zalo_session.connected": false, updated_at: new Date() } },
    );
}

/** Job đang xử lý lâu hơn mốc này coi như tiến trình đã chết giữa chừng. */
const STALE_JOB_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
    installShutdownHandlers();

    await connectMongo();
    await ensureIndexes();
    await ensureAppState();
    // Chưa kết nối Zalo thì phải nói là chưa. Nếu lần chạy trước bị giết đột ngột,
    // cờ "đang kết nối" còn sót lại trong DB sẽ khiến /health và /status báo sai.
    await markZaloDisconnected();
    onShutdown("mongodb", closeMongo);

    // Đăng ký lệnh TRƯỚC khi bật bot: startTelegramBot gắn handler theo danh sách lệnh
    // đã đăng ký, lệnh thêm sau sẽ không có tác dụng.
    registerReviewCommands();
    startTelegramBot();
    onShutdown("telegram", stopTelegramBot);

    // Job kẹt ở "processing" là dấu vết của lần chạy trước bị tắt đột ngột.
    const sweep = await requeueStaleJobs(STALE_JOB_MS);
    if (sweep.requeued > 0 || sweep.abandonedPosts > 0) {
        logger.warn(sweep, "Đã dọn job dở dang của lần chạy trước");
    }

    const listener = new MessageListener();
    const reconnect = new ReconnectManager(listener, notifyZaloIssue);

    onShutdown("zalo-listener", async () => {
        await reconnect.stop();
        // Chốt nốt các batch đang mở để tin nhắn vừa nhận không bị mất khi tắt máy.
        await listener.flushPending();
    });

    const extraction = startExtractionWorker(isShuttingDown);
    onShutdown("extraction-worker", () => extraction.stopped);

    const composer = startComposerWorker(isShuttingDown);
    onShutdown("composer-worker", () => composer.stopped);

    // Việc đăng bài do bộ điều phối cầm nhịp, không dùng vòng lặp poll như hai worker trên:
    // mỗi nhịp chỉ đúng một bài, và chỉ trong khung giờ cho phép.
    startScheduler(sendNotification);
    onShutdown("scheduler", stopScheduler);
    // Đóng trình duyệt SAU khi bộ điều phối dừng hẳn: đóng lúc Playwright đang thao tác
    // có thể làm hỏng hồ sơ trình duyệt, mà hồ sơ hỏng thì phải đăng nhập Facebook lại bằng tay.
    onShutdown("fb-browser", closeBrowser);

    startHealthServer();
    onShutdown("health-server", stopHealthServer);

    // Dọn ảnh/screenshot cũ hàng ngày + cảnh báo đầy đĩa hàng giờ — không liên quan tới pipeline
    // đăng bài nên bật độc lập, không phụ thuộc circuit breaker nào.
    startMaintenanceScheduler(sendNotification);
    onShutdown("maintenance-scheduler", stopMaintenanceScheduler);

    await reconnect.start();

    // In ra trần thu THỰC TẾ của từng nhóm, không chỉ con số mặc định: trần theo nhóm nằm trong
    // .env dưới dạng chuỗi threadId:số, gõ sai một ký tự là nhóm đó lặng lẽ rơi về mặc định.
    // Dòng này là chỗ duy nhất phát hiện được điều đó mà không phải chờ hết ngày rồi đếm tin.
    const intakeCaps = env.ZALO_ALLOWED_THREAD_IDS.length > 0
        ? env.ZALO_ALLOWED_THREAD_IDS.map(
              (id) => `${id}:${env.LISTINGS_PER_THREAD_OVERRIDES.get(id) ?? env.MAX_LISTINGS_PER_THREAD_PER_DAY}`,
          ).join(", ")
        : `mọi nhóm: ${env.MAX_LISTINGS_PER_THREAD_PER_DAY}`;

    const totalIntake = env.ZALO_ALLOWED_THREAD_IDS.reduce(
        (sum, id) => sum + (env.LISTINGS_PER_THREAD_OVERRIDES.get(id) ?? env.MAX_LISTINGS_PER_THREAD_PER_DAY),
        0,
    );

    const summary = {
        "Múi giờ": env.TZ,
        "Nhóm Zalo theo dõi": env.ZALO_ALLOWED_THREAD_IDS.length || "tất cả",
        "Trần thu mỗi nhóm": intakeCaps,
        "Tổng tin thu/ngày": totalIntake || "không giới hạn theo nhóm",
        "Hạn mức đăng": `${env.MAX_POSTS_PER_DAY} bài/ngày`,
        "Khung giờ đăng": `${env.ACTIVE_HOURS_START}h-${env.ACTIVE_HOURS_END}h`,
        "Trình duyệt": env.FB_HEADLESS ? "chạy ngầm" : "hiện cửa sổ",
    };

    logger.info(summary, "Agent đang chạy");
    await notifyStartup(summary);
}

main().catch((error) => {
    logger.fatal({ err: error }, "Khởi động thất bại");
    process.exit(1);
});
