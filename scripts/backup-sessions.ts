/**
 * Sao lưu phiên đăng nhập Zalo + hồ sơ trình duyệt Facebook.
 * Chạy: npm run backup:sessions
 *
 * Đây là dữ liệu quan trọng nhất trên đĩa — quan trọng hơn ảnh, hơn cả log. Mất nó thì phải
 * đăng nhập tay lại, mà đăng nhập Facebook lại từ IP mới là đúng kịch bản dễ dính checkpoint nhất.
 *
 * Nên chạy ngay sau mỗi lần đăng nhập thành công (login:zalo / login:facebook tự gọi), và định kỳ
 * hàng tuần (agent tự chạy — xem src/maintenance/cronJobs.ts). Bản sao nằm trong SESSION_BACKUP_DIR,
 * vẫn trên cùng VPS — nhớ copy ra ngoài (máy cá nhân, cloud) vì mất VPS là mất luôn cả bản sao.
 */
import { env } from "../src/config/env.js";
import { backupSessions } from "../src/maintenance/sessionBackup.js";
import { logger } from "../src/utils/logger.js";

async function main(): Promise<void> {
    const result = await backupSessions();

    console.log("\nĐã sao lưu xong.");
    console.log(`  Thư mục: ${result.destination}`);
    console.log(`  Dung lượng: ${(result.bytes / 1024 ** 2).toFixed(1)} MB`);
    console.log(`  Đã xoá ${result.rotated} bản cũ (giữ ${env.SESSION_BACKUP_KEEP} bản gần nhất)`);
    console.log("\nNhớ copy thư mục này ra khỏi VPS — mất VPS là mất luôn bản sao nằm trên đó.");
}

main().catch((error) => {
    logger.error({ err: error }, "Sao lưu phiên thất bại");
    process.exit(1);
});
