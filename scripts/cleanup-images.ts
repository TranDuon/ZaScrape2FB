/**
 * Dọn tay ảnh cũ + screenshot mồ côi trên đĩa. Logic thật nằm ở src/maintenance/imageCleanup.ts,
 * cũng được app tự gọi mỗi ngày (xem src/maintenance/cronJobs.ts) — script này chỉ để chạy tay
 * khi cần dọn ngay, ví dụ theo runbook trong plan.md lúc đĩa sắp đầy.
 *
 * Chạy: npx tsx scripts/cleanup-images.ts [--force]
 *   --force: bỏ qua điều kiện tuổi (IMAGE_RETENTION_DAYS/JOB_HISTORY_RETENTION_DAYS), xoá ngay
 *            mọi ảnh/screenshot đủ điều kiện trạng thái — dùng khi đĩa sắp đầy, cần giải phóng gấp.
 */
import { env } from "../src/config/env.js";
import { connectMongo, closeMongo } from "../src/db/mongoClient.js";
import { cleanupListingImages, cleanupOrphanedScreenshots } from "../src/maintenance/imageCleanup.js";
import { logger } from "../src/utils/logger.js";

const log = logger.child({ module: "cleanup-images-cli" });
const force = process.argv.includes("--force");

async function main(): Promise<void> {
    await connectMongo();

    log.info({ force, image_retention_days: env.IMAGE_RETENTION_DAYS }, "Bắt đầu dọn ảnh tin đăng đã chung cuộc");
    const { listingsCleaned, dirsRemoved } = await cleanupListingImages(force);
    log.info({ listingsCleaned, dirsRemoved }, "Xong phần ảnh tin đăng");

    log.info({ force, retention_days: env.JOB_HISTORY_RETENTION_DAYS }, "Bắt đầu dọn screenshot mồ côi");
    const screenshotsRemoved = await cleanupOrphanedScreenshots(force);
    log.info({ screenshotsRemoved }, "Xong phần screenshot");

    console.log(
        `\nĐã dọn ${listingsCleaned} tin đăng (${dirsRemoved} thư mục ảnh) và ${screenshotsRemoved} screenshot mồ côi.`,
    );

    await closeMongo();
}

main().catch(async (error) => {
    log.error({ err: error }, "Dọn ảnh thất bại");
    await closeMongo();
    process.exit(1);
});
