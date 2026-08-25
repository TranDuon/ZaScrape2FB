/**
 * Đăng nhập Zalo bằng QR — chạy tay MỘT LẦN, không phải tiến trình nền.
 *
 * Trên VPS không có màn hình: file QR được ghi ra data/zalo-session/login-qr.png,
 * copy về máy (scp) hoặc mở qua SFTP để quét bằng điện thoại.
 */
import { loginWithQR, hasSession } from "../src/zalo/zaloClient.js";
import { backupSessions } from "../src/maintenance/sessionBackup.js";
import { logger } from "../src/utils/logger.js";

async function main(): Promise<void> {
    if (await hasSession()) {
        logger.warn("Đã có phiên Zalo. Đăng nhập lại sẽ ghi đè phiên cũ.");
    }

    const api = await loginWithQR((qrPath) => {
        logger.info(`Mở file này và quét bằng app Zalo trên điện thoại: ${qrPath}`);
    });

    logger.info({ own_id: api.getOwnId() }, "Đăng nhập thành công, phiên đã được lưu");

    // Sao lưu ngay sau khi đăng nhập: quét QR lại là việc thủ công cần cầm điện thoại,
    // tránh được lần nào hay lần đó.
    try {
        const backup = await backupSessions();
        logger.info({ destination: backup.destination }, "Đã sao lưu phiên");
    } catch (error) {
        logger.warn({ err: error }, 'Không sao lưu được phiên — chạy tay "npm run backup:sessions"');
    }

    logger.info("Có thể khởi động service: npm run dev");
    process.exit(0);
}

main().catch((error) => {
    logger.error({ err: error }, "Đăng nhập Zalo thất bại");
    process.exit(1);
});
