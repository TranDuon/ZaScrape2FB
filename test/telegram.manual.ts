/**
 * Kiểm chứng Telegram + health endpoint bằng cách gửi tin thật.
 * Chạy: npm run test:telegram
 *
 * Sau khi chạy, mở Telegram xem bot đã gửi tin chưa, rồi thử gõ /status, /help.
 */
import { connectMongo, closeMongo } from "../src/db/mongoClient.js";
import { ensureAppState, ensureIndexes } from "../src/db/indexes.js";
import { startHealthServer, stopHealthServer } from "../src/health/healthServer.js";
import { isTelegramConfigured, sendNotification, startTelegramBot, stopTelegramBot } from "../src/notifier/telegramBot.js";
import { registerReviewCommands } from "../src/review/reviewFlow.js";
import { env } from "../src/config/env.js";

const LISTEN_SECONDS = 60;

async function main(): Promise<void> {
    if (!isTelegramConfigured()) {
        console.error("Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong .env");
        process.exit(1);
    }

    await connectMongo();
    await ensureIndexes();
    await ensureAppState();

    registerReviewCommands();
    startTelegramBot();
    startHealthServer();

    console.log("Đang gửi tin thử...");
    await sendNotification(
        [
            "🧪 Kiểm tra kết nối",
            "",
            "Nếu bạn đọc được tin này thì bot đã hoạt động.",
            "",
            "Thử các lệnh: /help /status /stats",
            "Và thử bấm nút bên dưới.",
        ].join("\n"),
        { keyboard: [[{ text: "🔘 Thử nút bấm", callback_data: "approve:khong-ton-tai" }]] },
    );
    console.log("Đã gửi. Kiểm tra Telegram của bạn.\n");

    // Health endpoint chỉ nghe localhost nên gọi từ chính máy này được.
    const url = `http://${env.HEALTH_CHECK_BIND}:${env.HEALTH_CHECK_PORT}/health`;
    const response = await fetch(url);
    const report = await response.json();
    console.log(`GET ${url} -> HTTP ${response.status}`);
    console.log(JSON.stringify(report, null, 2));

    console.log(`\nBot đang lắng nghe ${LISTEN_SECONDS} giây — hãy thử gõ lệnh trong Telegram ngay bây giờ...`);
    await new Promise((resolve) => setTimeout(resolve, LISTEN_SECONDS * 1000));

    await stopHealthServer();
    await stopTelegramBot();
    await closeMongo();
    console.log("\nKết thúc.");
    process.exit(0);
}

main().catch(async (error) => {
    console.error("Lỗi:", error instanceof Error ? error.message : error);
    await closeMongo();
    process.exit(1);
});
