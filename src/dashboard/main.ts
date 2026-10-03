/**
 * Điểm vào của dashboard: `npm run dashboard`, và là thứ shortcut khởi động cùng Windows chạy
 * (scripts/autostart/). Dashboard giữ agent chạy như tiến trình con — xem agentProcess.ts.
 *
 * File này CỐ Ý không import tĩnh module nào của dự án: mọi thứ phải chờ tới sau hai bước dưới,
 * mà import tĩnh thì chạy trước mọi dòng code của file.
 */
import fs from "node:fs";
import path from "node:path";

// 1. Chụp biến môi trường TRƯỚC khi nạp .env, để truyền cho agent. Truyền bản đã nạp thì dotenv
//    trong agent (không ghi đè biến có sẵn) sẽ lờ .env đi — sửa .env rồi bấm Chạy lại không ăn.
const agentEnv = { ...process.env };

// 2. Log của dashboard ghi sang thư mục con riêng. Hai tiến trình dài hạn cùng xoay vòng một file
//    pino-roll sẽ giẫm lên nhau lúc sang ngày; log agent vẫn ở LOG_DIR như cũ.
const dotenv = await import("dotenv");
dotenv.config();
const logDir = path.join(process.env.LOG_DIR ?? "./logs", "dashboard");
process.env.LOG_DIR = logDir;

try {
    const { startDashboard } = await import("./server.js");
    await startDashboard(agentEnv);
} catch (error) {
    const inUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
    const message = inUse
        ? "Dashboard đã đang chạy ở tiến trình khác — thoát (không chạy agent thứ hai)"
        : `Dashboard khởi động thất bại: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;

    // Ghi thẳng ra file, không qua logger: lỗi hay gặp nhất ở đây là .env không hợp lệ, mà khi đó
    // chính logger (phụ thuộc env.ts) cũng không dựng lên được. Chạy ẩn lúc mở máy thì không có
    // console nào để thấy — file này là dấu vết duy nhất.
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "startup-error.log"), `[${new Date().toISOString()}] ${message}\n`);
    console.error(message);
    process.exit(inUse ? 0 : 1);
}
