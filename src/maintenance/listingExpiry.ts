/**
 * Cho tin đăng chưa kịp lên Facebook hết hạn sau `LISTING_MAX_AGE_DAYS`.
 *
 * Hai lý do, và lý do đầu mới là lý do chính:
 *
 * 1. **Phòng trọ mất giá cực nhanh.** Đăng một phòng của 3 ngày trước thì phần lớn đã cho thuê
 *    xong — vừa ném đi một suất đăng trong ngày (chỉ có ~15 suất), vừa làm người đọc mất tin
 *    tưởng khi gọi tới thì phòng không còn.
 * 2. **Chặn hàng đợi phình vô hạn.** Lượng tin về từ Zalo lớn hơn nhiều lượng đăng được, nên
 *    không có mốc hết hạn thì tồn đọng chỉ có tăng, và `post_jobs` ở trạng thái `pending` KHÔNG
 *    có TTL nào dọn (TTL chỉ áp cho job đã kết thúc) — cuối cùng chạm trần 512MB của Atlas M0.
 *
 * Chỉ đụng tới tin CHƯA từng lên Facebook (`ready`/`queued`/`needs_review`). Tin đã `posted` giữ
 * nguyên làm lịch sử; tin `failed`/`duplicate` cũng giữ vì `/retry` còn dùng tới.
 */
import { listings, postJobs } from "../db/collections.js";
import { childLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import type { ListingStatus } from "../models/listing.model.js";

const log = childLogger("maintenance:expiry");

/** Trạng thái của tin còn đang chờ tới lượt đăng — chỉ những trạng thái này mới bị hết hạn. */
const PENDING_STATUSES: ListingStatus[] = ["ready", "queued", "needs_review"];

export interface ExpiryResult {
    listingsExpired: number;
    jobsCancelled: number;
}

export async function expireStaleListings(): Promise<ExpiryResult> {
    const cutoff = new Date(Date.now() - env.LISTING_MAX_AGE_DAYS * 86_400_000);
    const now = new Date();

    const stale = await listings()
        .find({ status: { $in: PENDING_STATUSES }, created_at: { $lt: cutoff } })
        .toArray();

    if (stale.length === 0) return { listingsExpired: 0, jobsCancelled: 0 };

    let jobsCancelled = 0;

    for (const listing of stale) {
        // Huỷ mọi job còn CHƯA chạy của tin này: cả job đăng bài lẫn job soạn bài đang bị hoãn.
        // KHÔNG đụng job `processing` — Playwright có thể đang gõ nội dung lên Facebook ngay lúc
        // này; và không đụng job `done` vì bài đã lên thì không rút về được.
        const cancelled = await postJobs().updateMany(
            { "payload.listing_id": listing._id, status: "pending" },
            {
                $set: {
                    status: "cancelled",
                    finished_at: now,
                    updated_at: now,
                    last_error: `Tin quá hạn ${env.LISTING_MAX_AGE_DAYS} ngày, không đăng nữa`,
                },
            },
        );
        jobsCancelled += cancelled.modifiedCount;

        await listings().updateOne(
            { _id: listing._id },
            {
                $set: { status: "expired" as ListingStatus, updated_at: now },
                $push: {
                    status_history: {
                        status: "expired" as ListingStatus,
                        at: now,
                        note: `Quá ${env.LISTING_MAX_AGE_DAYS} ngày chưa đăng được — phòng nhiều khả năng đã cho thuê`,
                    },
                },
            },
        );
    }

    log.info(
        { listings_expired: stale.length, jobs_cancelled: jobsCancelled, max_age_days: env.LISTING_MAX_AGE_DAYS },
        "Đã cho tin đăng quá hạn hết hiệu lực",
    );

    return { listingsExpired: stale.length, jobsCancelled };
}
