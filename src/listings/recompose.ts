import type { ObjectId } from "mongodb";
import { listings } from "../db/collections.js";
import { cancelPendingPostJobs, countPostJobsByStatus, enqueueJob } from "../jobs/jobQueue.js";
import type { ListingDoc } from "../models/listing.model.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("listings:recompose");

export interface RecomposeResult {
    ok: boolean;
    /** Số group sẽ nhận nội dung mới. */
    pendingCancelled: number;
    /** Số group đã đăng xong bằng nội dung cũ — không thể thu hồi. */
    alreadyPosted: number;
    /** Số group đang đăng dở ngay lúc này. */
    inFlight: number;
    message: string;
}

/**
 * Soạn lại bài sau khi người dùng sửa dữ liệu của một listing đã ở trạng thái `queued`.
 *
 * Bài đã lên Facebook thì không rút lại được — sửa trong MongoDB không đổi được nội dung
 * đã đăng. Vì vậy hàm này chỉ can thiệp vào phần còn đăng được, và trả về con số cụ thể
 * để người dùng biết chính xác thay đổi có hiệu lực với bao nhiêu group.
 */
export async function recomposeListing(listingId: ObjectId): Promise<RecomposeResult> {
    const listing = (await listings().findOne({ _id: listingId })) as ListingDoc | null;

    if (!listing) {
        return { ok: false, pendingCancelled: 0, alreadyPosted: 0, inFlight: 0, message: "Không tìm thấy tin đăng" };
    }

    if (listing.status === "posted" || listing.status === "rejected" || listing.status === "ignored") {
        return {
            ok: false,
            pendingCancelled: 0,
            alreadyPosted: 0,
            inFlight: 0,
            message: `Tin đăng đang ở trạng thái "${listing.status}", không soạn lại được`,
        };
    }

    const before = await countPostJobsByStatus(listingId);
    const alreadyPosted = before.done ?? 0;
    const inFlight = (before.claimed ?? 0) + (before.processing ?? 0);

    const pendingCancelled = await cancelPendingPostJobs(listingId);

    const now = new Date();
    await listings().updateOne(
        { _id: listingId },
        {
            $set: { status: "ready", updated_at: now },
            $push: {
                status_history: {
                    status: "ready" as const,
                    at: now,
                    note: `Soạn lại nội dung, đã huỷ ${pendingCancelled} job đăng đang chờ`,
                },
            },
        },
    );

    // attempt_seq mới để không đụng unique index của các job cũ cùng listing/group.
    await enqueueJob({ type: "compose_post", listingId, attemptSeq: Date.now() });

    const parts = [`Đã cập nhật, sẽ soạn lại nội dung cho ${pendingCancelled} group còn lại.`];
    if (alreadyPosted > 0) {
        parts.push(`${alreadyPosted} group đã đăng trước đó vẫn giữ nội dung cũ (không thu hồi được).`);
    }
    if (inFlight > 0) {
        parts.push(`${inFlight} group đang đăng dở ngay lúc này nên vẫn dùng nội dung cũ.`);
    }

    const message = parts.join(" ");
    log.info({ listing_id: listingId, pendingCancelled, alreadyPosted, inFlight }, "Đã kích hoạt soạn lại bài");

    return { ok: true, pendingCancelled, alreadyPosted, inFlight, message };
}
