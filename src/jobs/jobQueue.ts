import { createHash } from "node:crypto";
import { MongoServerError, ObjectId } from "mongodb";
import { postJobs } from "../db/collections.js";
import { childLogger } from "../utils/logger.js";
import type { JobDoc, JobType } from "../models/job.model.js";

const log = childLogger("jobs:queue");

/** Mã lỗi duplicate key của MongoDB — dùng để nhận biết job đã tồn tại. */
const DUPLICATE_KEY = 11000;

export interface EnqueueOptions {
    type: JobType;
    listingId: ObjectId;
    groupId?: ObjectId | null;
    composedText?: string | null;
    /** Thời điểm sớm nhất được phép chạy. Mặc định: ngay lập tức. */
    scheduledAt?: Date;
    /** Tăng khi người dùng chủ động /retry để tạo được job mới sau khi job cũ đã kết thúc. */
    attemptSeq?: number;
    maxAttempts?: number;
}

/**
 * BẮT BUỘC gồm cả `type`: thiếu nó, `extract_listing` và `compose_post` của CÙNG một listing
 * (đều có group_id=null, attempt_seq=0) tạo ra hash giống hệt nhau. Lúc extractionWorker gọi
 * enqueueJob(compose_post) thì job extract_listing gốc vẫn còn `processing` (chưa completeJob) —
 * unique index (áp dụng cho status pending/claimed/processing) chặn luôn job compose_post, lỗi bị
 * enqueueJob nuốt êm (coi là job trùng), và listing nằm mãi ở `ready` không bao giờ được soạn bài.
 * Đây từng là bug thật: mọi listing `ready` trong lịch sử dự án chưa từng thực sự tạo được job
 * compose_post qua đường tự động, chỉ lộ ra khi có dữ liệu thật/tin tiêm chạy qua đủ pipeline.
 */
export function buildIdempotencyKey(
    type: JobType,
    listingId: ObjectId,
    groupId: ObjectId | null,
    attemptSeq: number,
): string {
    return createHash("sha1")
        .update(`${type}:${listingId.toHexString()}:${groupId?.toHexString() ?? "none"}:${attemptSeq}`)
        .digest("hex");
}

/**
 * Đưa job vào hàng đợi. Trả về job đã tạo, hoặc null nếu đã tồn tại job tương đương
 * đang chờ/đang chạy (unique partial index chặn) — trường hợp này là bình thường,
 * xảy ra khi worker chạy lại sau khi khởi động lại giữa chừng.
 */
export async function enqueueJob(options: EnqueueOptions): Promise<JobDoc | null> {
    const now = new Date();
    const attemptSeq = options.attemptSeq ?? 0;
    const groupId = options.groupId ?? null;

    const job: JobDoc = {
        type: options.type,
        status: "pending",
        payload: {
            listing_id: options.listingId,
            group_id: groupId,
            composed_text: options.composedText ?? null,
        },
        attempts: 0,
        attempt_seq: attemptSeq,
        max_attempts: options.maxAttempts ?? 3,
        idempotency_key: buildIdempotencyKey(options.type, options.listingId, groupId, attemptSeq),
        last_error: null,
        scheduled_at: options.scheduledAt ?? now,
        claimed_at: null,
        claimed_by: null,
        started_at: null,
        finished_at: null,
        created_at: now,
        updated_at: now,
    };

    try {
        const result = await postJobs().insertOne(job);
        log.debug({ job_id: result.insertedId, type: job.type }, "Đã tạo job");
        return { ...job, _id: result.insertedId };
    } catch (error) {
        if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) {
            log.debug({ type: options.type, listing_id: options.listingId }, "Job tương đương đang chờ, bỏ qua");
            return null;
        }
        throw error;
    }
}

/** Định danh tiến trình đang giữ job — hữu ích khi soi DB lúc có nhiều instance chạy. */
const WORKER_ID = `${process.pid}@${process.env.HOSTNAME ?? "local"}`;

/**
 * Nhận một job đến hạn theo cách nguyên tử.
 *
 * `findOneAndUpdate` đảm bảo chỉ đúng một tiến trình nhận được job, kể cả khi
 * chạy nhiều instance song song — đây là điều kiện tiên quyết để không đăng trùng bài.
 */
/**
 * Thứ tự lấy job khi có nhiều job cùng đến hạn.
 *
 * `newest_first` tồn tại vì lượng tin về từ Zalo lớn hơn lượng đăng được: khi có tồn đọng, lấy
 * theo FIFO nghĩa là luôn soạn bài cho phòng CŨ NHẤT — mà phòng trọ để vài ngày thì phần lớn đã
 * cho thuê xong. Job bị hoãn giữ nguyên `created_at` nên tự động xếp sau tin mới, đúng ý muốn.
 *
 * Riêng `post_to_group` PHẢI giữ `oldest_first`: mốc `scheduled_at` của chúng do
 * `staggeredSchedule` rải ra có chủ đích, đảo thứ tự là phá luôn khoảng giãn cách đó.
 */
export type ClaimOrder = "oldest_first" | "newest_first";

export async function claimNextJob(type: JobType, order: ClaimOrder = "oldest_first"): Promise<JobDoc | null> {
    const now = new Date();

    const job = await postJobs().findOneAndUpdate(
        { type, status: "pending", scheduled_at: { $lte: now } },
        {
            $set: {
                status: "processing",
                claimed_at: now,
                claimed_by: WORKER_ID,
                started_at: now,
                updated_at: now,
            },
            $inc: { attempts: 1 },
        },
        {
            // Bộ lọc đã chặn job chưa đến hạn, nên `newest_first` chỉ cần xét độ tươi của tin.
            sort: order === "newest_first" ? { created_at: -1 } : { scheduled_at: 1 },
            returnDocument: "after",
        },
    );

    return job ?? null;
}

/**
 * Nhận nhiều job đến hạn cùng lúc, để gộp chúng vào MỘT lần gọi Gemini.
 *
 * Cố ý lặp lại `claimNextJob` thay vì viết một câu lệnh Mongo gom nhiều document: MongoDB không
 * có `findAndUpdateMany` trả về document, nên mọi cách "gom một phát" đều phải đọc trước rồi ghi
 * sau — kẽ hở đủ để hai tiến trình cùng nhận một job. Mỗi vòng lặp ở đây vẫn là một
 * `findOneAndUpdate` nguyên tử, tức là giữ nguyên bất biến "một job chỉ thuộc về một worker",
 * đổi lại vài lượt round-trip cho một con số nhỏ (mặc định 3-5).
 *
 * Trả về mảng có thể ngắn hơn `limit` — kể cả rỗng — khi hàng đợi hết việc.
 */
export async function claimNextJobs(type: JobType, limit: number, order: ClaimOrder = "oldest_first"): Promise<JobDoc[]> {
    const claimed: JobDoc[] = [];

    for (let i = 0; i < limit; i++) {
        const job = await claimNextJob(type, order);
        if (!job) break;
        claimed.push(job);
    }

    return claimed;
}

export async function completeJob(jobId: ObjectId): Promise<void> {
    const now = new Date();
    await postJobs().updateOne(
        { _id: jobId },
        { $set: { status: "done", finished_at: now, updated_at: now, last_error: null } },
    );
}

/**
 * Ghi nhận job lỗi. Còn lượt thì trả về hàng đợi với thời điểm lùi lại (backoff),
 * hết lượt thì đánh dấu thất bại hẳn để người dùng biết mà xử lý.
 */
export async function failJob(job: JobDoc, error: unknown, backoffMs: number): Promise<"retry" | "failed"> {
    const now = new Date();
    const message = error instanceof Error ? error.message : String(error);
    const canRetry = job.attempts < job.max_attempts;

    if (canRetry) {
        await postJobs().updateOne(
            { _id: job._id },
            {
                $set: {
                    status: "pending",
                    scheduled_at: new Date(now.getTime() + backoffMs),
                    claimed_at: null,
                    claimed_by: null,
                    last_error: message,
                    updated_at: now,
                },
            },
        );
        return "retry";
    }

    await postJobs().updateOne(
        { _id: job._id },
        { $set: { status: "failed", finished_at: now, last_error: message, updated_at: now } },
    );
    return "failed";
}

/**
 * Trả job về hàng đợi để chạy vào lúc khác — KHÔNG tính là một lần thử thất bại.
 *
 * Khác `failJob` ở chỗ không có gì hỏng cả, chỉ là chưa tới lượt (đã hết ngân sách soạn bài
 * trong ngày). Vì vậy phải HOÀN LẠI `attempts` mà `claimNextJob` vừa cộng: nếu không, một tin
 * bị hoãn ba ngày liên tiếp sẽ cạn `max_attempts` rồi bị đánh `failed` dù chưa từng thực sự
 * được xử lý lần nào.
 */
export async function deferJob(job: JobDoc, until: Date, reason: string): Promise<void> {
    const now = new Date();

    await postJobs().updateOne(
        { _id: job._id },
        {
            $set: {
                status: "pending",
                scheduled_at: until,
                claimed_at: null,
                claimed_by: null,
                last_error: reason,
                updated_at: now,
            },
            $inc: { attempts: -1 },
        },
    );
}

export interface StaleJobSweep {
    /** Job an toàn đã được trả lại hàng đợi để chạy lại. */
    requeued: number;
    /** Job đăng bài bị chặn không cho chạy lại vì có thể bài đã lên Facebook. */
    abandonedPosts: number;
}

/**
 * Dọn job bị kẹt ở `processing` quá lâu.
 *
 * Bắt buộc phải có: listener và worker chạy chung một tiến trình, nên khi tiến trình
 * chết giữa lúc đang xử lý, job sẽ nằm lại ở `processing` vĩnh viễn nếu không ai dọn.
 *
 * Xử lý KHÁC NHAU theo loại job, và đây là điểm quan trọng nhất của hàm này:
 *
 *  - `extract_listing`/`compose_post`: gọi Gemini rồi ghi lại vào MongoDB, chạy lại chỉ tốn
 *    thêm ít quota chứ không để lại hậu quả ra bên ngoài -> trả về `pending` để chạy lại.
 *
 *  - `post_to_group`: KHÔNG BAO GIỜ trả về hàng đợi. Tiến trình có thể đã chết ngay SAU khi
 *    Playwright bấm nút Đăng nhưng TRƯỚC khi `completeJob` kịp chạy — nghĩa là bài rất có thể
 *    đã nằm trên Facebook rồi. Cho chạy lại là đăng trùng đúng nội dung lên đúng nhóm đó, vừa
 *    lộ liễu là bot vừa không rút lại được. Đánh dấu `failed` để dừng hẳn; bản ghi
 *    `post_history` treo ở `attempting` là bằng chứng để `stalePostReaper` báo người dùng
 *    tự kiểm tra.
 */
export async function requeueStaleJobs(staleAfterMs: number): Promise<StaleJobSweep> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const now = new Date();

    const requeued = await postJobs().updateMany(
        { status: "processing", claimed_at: { $lt: cutoff }, type: { $ne: "post_to_group" } },
        {
            $set: {
                status: "pending",
                claimed_at: null,
                claimed_by: null,
                last_error: "Tiến trình dừng đột ngột khi đang xử lý",
                updated_at: now,
            },
        },
    );

    const abandoned = await postJobs().updateMany(
        { status: "processing", claimed_at: { $lt: cutoff }, type: "post_to_group" },
        {
            $set: {
                status: "failed",
                finished_at: now,
                last_error: "Tiến trình chết giữa lúc đăng — có thể bài đã lên Facebook, không tự đăng lại",
                updated_at: now,
            },
        },
    );

    if (abandoned.modifiedCount > 0) {
        log.warn(
            { count: abandoned.modifiedCount },
            "Có job đăng bài chết giữa chừng — đánh dấu thất bại, KHÔNG đăng lại để tránh trùng bài",
        );
    }

    return { requeued: requeued.modifiedCount, abandonedPosts: abandoned.modifiedCount };
}

/**
 * Huỷ các job đăng bài còn đang chờ của một listing.
 *
 * Dùng khi người dùng sửa nội dung lúc listing đã ở `queued`: các snapshot đã chốt
 * trong `payload.composed_text` giờ đã lỗi thời, phải bỏ đi rồi soạn lại.
 *
 * CHỈ huỷ job chưa chạy. Job đang `processing` không đụng tới vì Playwright có thể đang
 * gõ nội dung lên Facebook ngay lúc này; job đã `done` lại càng không — bài đã lên rồi,
 * xoá trong DB không rút bài về được.
 */
export async function cancelPendingPostJobs(listingId: ObjectId): Promise<number> {
    const now = new Date();

    const result = await postJobs().updateMany(
        { "payload.listing_id": listingId, type: "post_to_group", status: "pending" },
        {
            $set: {
                status: "cancelled",
                finished_at: now,
                updated_at: now,
                last_error: "Người dùng sửa nội dung, bài đăng được soạn lại",
            },
        },
    );

    if (result.modifiedCount > 0) {
        log.info({ listing_id: listingId, cancelled: result.modifiedCount }, "Đã huỷ job đăng bài đang chờ");
    }

    return result.modifiedCount;
}

/** Đếm job đăng bài theo trạng thái — dùng để báo cho người dùng biết còn bao nhiêu group chưa đăng. */
export async function countPostJobsByStatus(listingId: ObjectId): Promise<Record<string, number>> {
    const rows = await postJobs()
        .aggregate<{ _id: string; n: number }>([
            { $match: { "payload.listing_id": listingId, type: "post_to_group" } },
            { $group: { _id: "$status", n: { $sum: 1 } } },
        ])
        .toArray();

    return Object.fromEntries(rows.map((row) => [row._id, row.n]));
}
