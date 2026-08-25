/**
 * Dọn ảnh cũ trên đĩa. MongoDB không quản lý file ảnh nên không có TTL index nào lo việc này —
 * xem `scripts/cleanup-images.ts` cho phần chạy tay/CLI (`--force`) và `src/maintenance/cronJobs.ts`
 * cho phần chạy tự động mỗi ngày trong app.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { listings } from "../db/collections.js";
import { childLogger } from "../utils/logger.js";
import type { ListingStatus } from "../models/listing.model.js";

const log = childLogger("maintenance:images");

// Trạng thái mà state machine (xem plan.md) không bao giờ quay lại sau khi đạt tới — khác với
// "failed"/"duplicate" vẫn có thể được /retry soạn lại và cần ảnh gốc còn nguyên.
const TERMINAL_STATUSES: ListingStatus[] = ["posted", "ignored", "rejected", "expired"];

export interface ImageCleanupResult {
    listingsCleaned: number;
    dirsRemoved: number;
}

async function removeDirIfExists(dirPath: string): Promise<boolean> {
    try {
        await fs.rm(dirPath, { recursive: true, force: true });
        return true;
    } catch (error) {
        log.warn({ dir: dirPath, err: error }, "Không xoá được thư mục ảnh");
        return false;
    }
}

/** @param force Bỏ qua điều kiện tuổi, chỉ lọc theo trạng thái — dùng khi đĩa sắp đầy. */
export async function cleanupListingImages(force = false): Promise<ImageCleanupResult> {
    const cutoff = force ? new Date() : new Date(Date.now() - env.IMAGE_RETENTION_DAYS * 86_400_000);

    const cursor = listings().find({
        status: { $in: TERMINAL_STATUSES },
        created_at: { $lt: cutoff },
        images: { $elemMatch: { storage: "local" } },
    });

    let listingsCleaned = 0;
    let dirsRemoved = 0;

    for await (const listing of cursor) {
        const localImages = listing.images.filter((image) => image.storage === "local" && image.local_path);
        if (localImages.length === 0) continue;

        // Mỗi tin đăng có đúng một thư mục ảnh riêng (mediaDownloader.ts: tên ban đầu theo
        // thread+message đầu tiên, có thể đã được relocateListingImages đổi sang tên theo địa chỉ)
        // -> gom về tập thư mục cha duy nhất theo local_path hiện tại rồi xoá một lần.
        const dirs = new Set(localImages.map((image) => path.dirname(path.resolve(image.local_path as string))));

        let allRemoved = true;
        for (const dir of dirs) {
            const ok = await removeDirIfExists(dir);
            if (ok) dirsRemoved++;
            else allRemoved = false;
        }

        if (!allRemoved) continue;

        await listings().updateOne(
            { _id: listing._id },
            {
                $set: {
                    images: listing.images.map((image) =>
                        image.storage === "local" ? { ...image, storage: "none", local_path: null } : image,
                    ),
                    updated_at: new Date(),
                },
            },
        );

        listingsCleaned++;
    }

    return { listingsCleaned, dirsRemoved };
}

/**
 * Screenshot chụp lúc checkpoint/lỗi được tham chiếu qua `post_history.screenshot_path`, nhưng
 * `post_history` tự xoá theo TTL sau JOB_HISTORY_RETENTION_DAYS -> screenshot sẽ mồ côi. Dọn theo
 * tuổi file (mtime) chứ không tra cứu lại `post_history`, vì sau TTL bản ghi đã mất rồi.
 */
export async function cleanupOrphanedScreenshots(force = false): Promise<number> {
    const dir = path.resolve(env.FB_SCREENSHOT_DIR);

    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return 0; // Chưa từng chụp ảnh nào -> thư mục có thể chưa tồn tại, không phải lỗi.
    }

    const cutoffMs = force ? Date.now() : Date.now() - env.JOB_HISTORY_RETENTION_DAYS * 86_400_000;
    let removed = 0;

    for (const name of entries) {
        const filePath = path.join(dir, name);
        try {
            const stat = await fs.stat(filePath);
            if (!stat.isFile()) continue;
            if (stat.mtimeMs < cutoffMs) {
                await fs.unlink(filePath);
                removed++;
            }
        } catch (error) {
            log.warn({ file: filePath, err: error }, "Không xoá được screenshot mồ côi");
        }
    }

    return removed;
}
