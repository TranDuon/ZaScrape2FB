/**
 * Đăng nhập Facebook một lần cho agent — chạy TAY, không phải tiến trình nền.
 * Chạy: npm run login:facebook
 *
 * Script mở trình duyệt thật để BẠN tự đăng nhập bằng tay. Agent cố ý không tự điền
 * tài khoản/mật khẩu: đăng nhập tự động là hành vi Facebook soi kỹ nhất, và cất mật khẩu
 * trong .env để bot dùng là rủi ro không đáng đánh đổi.
 *
 * Phiên được lưu vào FB_BROWSER_PROFILE_DIR và dùng lại cho mọi lần chạy sau.
 */
import { env } from "../src/config/env.js";
import { checkSession, closeBrowser, getBrowserContext, newPage } from "../src/facebook/fbBrowser.js";
import { backupSessions } from "../src/maintenance/sessionBackup.js";
import { logger } from "../src/utils/logger.js";

const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;

async function main(): Promise<void> {
    if (env.FB_HEADLESS) {
        console.error("Không đăng nhập được ở chế độ headless — cần nhìn thấy trình duyệt để thao tác.");
        console.error("Đặt FB_HEADLESS=false trong .env rồi chạy lại.");
        process.exit(1);
    }

    await getBrowserContext();
    const page = await newPage();

    const before = await checkSession(page);
    if (before.loggedIn) {
        console.log("Đã đăng nhập sẵn — không cần làm gì thêm.");
        console.log("Muốn đổi tài khoản: đăng xuất trong cửa sổ vừa mở rồi chạy lại lệnh này.");
        await closeBrowser();
        process.exit(0);
    }

    console.log("\n=== ĐĂNG NHẬP FACEBOOK ===");
    console.log("Cửa sổ trình duyệt đã mở. Hãy tự đăng nhập trong đó.");
    console.log("Sau khi vào được trang chủ, script sẽ tự nhận ra và lưu phiên lại.\n");
    console.log("Lưu ý: nếu Facebook hỏi mã xác minh, cứ hoàn tất bình thường trong cửa sổ đó.\n");

    const deadline = Date.now() + WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        const status = await checkSession(page);
        if (status.loggedIn) {
            console.log("\nĐăng nhập thành công. Phiên đã được lưu vào:", env.FB_BROWSER_PROFILE_DIR);

            // Sao lưu NGAY, trước khi làm gì khác: đây là thời điểm phiên sạch nhất (trình duyệt
            // vừa đóng hẳn, không có file SQLite nào đang ghi dở) và cũng là lúc nó quý nhất —
            // vừa phải đăng nhập tay xong, không ai muốn làm lại lần nữa.
            await closeBrowser();
            try {
                const backup = await backupSessions();
                console.log(`\nĐã sao lưu phiên vào: ${backup.destination}`);
            } catch (error) {
                console.warn("\nCảnh báo: không sao lưu được phiên —", error instanceof Error ? error.message : error);
                console.warn('Chạy tay "npm run backup:sessions" để thử lại.');
            }

            console.log("\nTiếp theo, nên chạy thử một bài lên nhóm test trước khi bật tự động:");
            console.log("  npm run test:fbpost -- <id-group> --dry-run");
            process.exit(0);
        }

        const remaining = Math.round((deadline - Date.now()) / 60_000);
        console.log(`Đang chờ... (còn ${remaining} phút) — ${status.reason}`);
    }

    console.error("\nHết thời gian chờ đăng nhập.");
    await closeBrowser();
    process.exit(1);
}

main().catch(async (error) => {
    logger.error({ err: error }, "Đăng nhập Facebook thất bại");
    await closeBrowser();
    process.exit(1);
});
