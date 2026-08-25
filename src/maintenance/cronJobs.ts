import cron, { type ScheduledTask } from "node-cron";
import { APP_STATE_ID } from "../config/constants.js";
import { env } from "../config/env.js";
import { appState } from "../db/collections.js";
import type { NotifyFn } from "../jobs/postingWorker.js";
import { cleanupListingImages, cleanupOrphanedScreenshots } from "./imageCleanup.js";
import { backupSessions } from "./sessionBackup.js";
import { expireStaleListings } from "./listingExpiry.js";
import { sweepStaleAttempts } from "./stalePostReaper.js";
import { getDiskUsage } from "../utils/diskUsage.js";
import { childLogger } from "../utils/logger.js";
import { businessDateKey } from "../utils/time.js";

const log = childLogger("maintenance:cron");

let imageCleanupTask: ScheduledTask | null = null;
let listingExpiryTask: ScheduledTask | null = null;
let diskCheckTask: ScheduledTask | null = null;
let stalePostTask: ScheduledTask | null = null;
let backupTask: ScheduledTask | null = null;

/** Cho tin quá hạn hết hiệu lực. Lỗi ở đây không được phép giết lịch bảo trì. */
async function runListingExpiry(): Promise<void> {
    try {
        await expireStaleListings();
    } catch (error) {
        log.error({ err: error }, "Cho tin quá hạn hết hiệu lực thất bại");
    }
}

async function runImageCleanup(): Promise<void> {
    try {
        const images = await cleanupListingImages();
        const screenshots = await cleanupOrphanedScreenshots();
        log.info(
            { listings_cleaned: images.listingsCleaned, dirs_removed: images.dirsRemoved, screenshots_removed: screenshots },
            "Dọn ảnh/screenshot cũ hàng ngày xong",
        );
    } catch (error) {
        log.error({ err: error }, "Dọn ảnh/screenshot hàng ngày thất bại");
    }
}

/**
 * Cảnh báo đầy đĩa chỉ báo một lần mỗi ngày (giờ VN) khi vượt ngưỡng, kể cả khi lần kiểm tra
 * nào trong ngày cũng vượt — nếu không người dùng sẽ nhận tin nhắn giống hệt nhau mỗi giờ.
 * Khi đĩa tụt xuống dưới ngưỡng, cờ tự động được xoá ở lần vượt ngưỡng tiếp theo (không cần
 * dọn cờ chủ động, vì so sánh lại theo ngày hiện tại mỗi lần).
 */
async function runDiskCheck(notify: NotifyFn): Promise<void> {
    try {
        const usage = await getDiskUsage(process.cwd());
        log.debug({ percent_used: usage.percentUsed }, "Kiểm tra dung lượng đĩa");

        if (usage.percentUsed < env.DISK_USAGE_WARN_PERCENT) return;

        const today = businessDateKey();
        const state = await appState().findOne({ _id: APP_STATE_ID });
        if (state?.disk_warning?.last_notified_date === today) return; // đã báo hôm nay rồi

        await appState().updateOne(
            { _id: APP_STATE_ID },
            { $set: { "disk_warning.last_notified_date": today, updated_at: new Date() } },
        );

        const freeGb = (usage.freeBytes / 1024 ** 3).toFixed(1);
        await notify(
            `⚠️ ĐĨA SẮP ĐẦY: đã dùng ${usage.percentUsed}% (còn ${freeGb} GB trống).\n` +
                `Chạy "npx tsx scripts/cleanup-images.ts --force" để giải phóng gấp, hoặc tăng ổ đĩa.`,
        );
        log.warn({ percent_used: usage.percentUsed }, "Đã cảnh báo đầy đĩa qua Telegram");
    } catch (error) {
        log.error({ err: error }, "Kiểm tra dung lượng đĩa thất bại");
    }
}

async function runStalePostSweep(notify: NotifyFn): Promise<void> {
    try {
        await sweepStaleAttempts(notify);
    } catch (error) {
        log.error({ err: error }, "Quét lần đăng treo thất bại");
    }
}

async function runSessionBackup(notify: NotifyFn): Promise<void> {
    try {
        const result = await backupSessions();
        log.info({ destination: result.destination }, "Đã sao lưu phiên định kỳ");
    } catch (error) {
        // Sao lưu hỏng là chuyện đáng báo: người dùng đang tin là mình có bản sao dự phòng,
        // và chỉ phát hiện ra là không có đúng vào lúc cần nó nhất.
        const message = error instanceof Error ? error.message : String(error);
        log.error({ err: error }, "Sao lưu phiên định kỳ thất bại");
        await notify(`⚠️ Sao lưu phiên đăng nhập thất bại: ${message}\n\nChạy tay: npm run backup:sessions`);
    }
}

/**
 * Bật lịch dọn dẹp tự động: ảnh/screenshot cũ mỗi ngày lúc 3h15 sáng giờ VN (ngoài khung giờ
 * đăng bài, ít traffic), kiểm tra dung lượng đĩa mỗi giờ, và quét lần đăng treo mỗi 10 phút.
 * Chọn chạy trong app thay vì crontab riêng của VPS, cùng lý do với log rotation: hành vi giống
 * hệt nhau giữa dev và VPS.
 *
 * Toàn bộ lịch ở đây độc lập với cầu dao Facebook: cầu dao ngắt thì việc đăng bài dừng, nhưng
 * đĩa vẫn đầy lên và bài treo vẫn cần được báo — thậm chí lúc đó còn cần hơn.
 */
export function startMaintenanceScheduler(notify: NotifyFn): void {
    imageCleanupTask = cron.schedule("15 3 * * *", () => void runImageCleanup(), { timezone: env.TZ });
    // Cho tin quá hạn hết hiệu lực TRƯỚC nhịp dọn ảnh 15 phút: tin vừa chuyển sang `expired` sẽ
    // được chính lần dọn ảnh ngay sau đó thu hồi luôn đĩa, thay vì phải đợi thêm một ngày.
    listingExpiryTask = cron.schedule("0 3 * * *", () => void runListingExpiry(), { timezone: env.TZ });
    diskCheckTask = cron.schedule("0 * * * *", () => void runDiskCheck(notify), { timezone: env.TZ });
    // Dày hơn hẳn hai việc trên: "có thể có bài đã lên Facebook mà hệ thống không biết" là thứ
    // người dùng cần biết trong vòng vài phút, không phải sáng hôm sau.
    stalePostTask = cron.schedule("*/10 * * * *", () => void runStalePostSweep(notify), {
        timezone: env.TZ,
        noOverlap: true,
    });
    // Chủ nhật 3h45 sáng: sau lần dọn ảnh nên bản sao không ôm theo ảnh sắp bị xoá,
    // và vẫn nằm ngoài khung giờ đăng bài nên trình duyệt gần như chắc chắn đang đóng.
    backupTask = cron.schedule("45 3 * * 0", () => void runSessionBackup(notify), {
        timezone: env.TZ,
        noOverlap: true,
    });

    log.info({ timezone: env.TZ }, "Đã bật lịch dọn ảnh, kiểm tra đĩa, quét lần đăng treo và sao lưu phiên");
}

export async function stopMaintenanceScheduler(): Promise<void> {
    await imageCleanupTask?.stop();
    await listingExpiryTask?.stop();
    await diskCheckTask?.stop();
    await stalePostTask?.stop();
    await backupTask?.stop();
    imageCleanupTask = null;
    listingExpiryTask = null;
    diskCheckTask = null;
    stalePostTask = null;
    backupTask = null;
}
