import type { ObjectId } from "mongodb";
import { env } from "../config/env.js";
import { listings } from "../db/collections.js";
import { incrementDailyMetric } from "../db/indexes.js";
import { evaluate } from "../llm/confidenceGate.js";
import { extractListings, type ExtractionOutcome } from "../llm/extractor.js";
import { isGeminiConfigured } from "../llm/geminiClient.js";
import type { JobDoc } from "../models/job.model.js";
import type { ListingDoc, ListingStatus } from "../models/listing.model.js";
import { backoffDelay } from "../utils/delay.js";
import { childLogger } from "../utils/logger.js";
import { notifyExtracted, notifyNeedsReview } from "../notifier/notifyEvents.js";
import { relocateListingImages } from "../zalo/mediaDownloader.js";
import { collectJobBatch } from "./batchCollector.js";
import { completeJob, enqueueJob, failJob } from "./jobQueue.js";

const log = childLogger("jobs:extraction");

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60 * 1000;

/** Đổi trạng thái listing và ghi vào lịch sử để truy vết được đường đi của tin đăng. */
async function setStatus(listingId: ObjectId, status: ListingStatus, note: string | null): Promise<void> {
    const now = new Date();
    await listings().updateOne(
        { _id: listingId },
        {
            $set: { status, updated_at: now },
            $push: { status_history: { status, at: now, note } },
        },
    );
}

/**
 * Ghi kết quả trích xuất của MỘT tin xuống DB và đẩy tin đi tiếp trong pipeline.
 *
 * Tách khỏi phần gọi Gemini vì một lần gọi giờ phục vụ cả lô: phần gọi chạy một lần, phần này
 * chạy cho từng tin, và lỗi ở đây chỉ ảnh hưởng đúng tin đó.
 */
async function applyOutcome(job: JobDoc, listing: ListingDoc, outcome: ExtractionOutcome): Promise<void> {
    const listingId = listing._id as ObjectId;
    const decision = evaluate(outcome.result, outcome.parsedData);
    const now = new Date();

    // Đổi tên thư mục ảnh từ khoá tạm (thread+message) sang địa chỉ vừa trích xuất được, để dò
    // dữ liệu trên đĩa bằng mắt thường thay vì phải tra ngược ObjectId. Chỉ đổi được khi có địa
    // chỉ; tin `ignored`/thiếu địa chỉ giữ nguyên tên thư mục cũ.
    const images = await relocateListingImages(listing.images, listingId, outcome.parsedData.address.raw);

    await listings().updateOne(
        { _id: listingId },
        {
            $set: {
                is_listing: outcome.result.is_listing,
                is_listing_reason: outcome.result.is_listing_reason,
                parsed_data: outcome.parsedData,
                images,
                confidence_score: outcome.result.confidence,
                missing_required_fields: decision.missingFields,
                extraction_meta: {
                    model: outcome.model,
                    prompt_version: outcome.promptVersion,
                    attempts: job.attempts,
                    last_error: null,
                },
                status: decision.status,
                updated_at: now,
            },
            $push: { status_history: { status: decision.status, at: now, note: decision.reason } },
        },
    );

    await incrementDailyMetric("extraction_count");
    await incrementDailyMetric("extraction_time_ms_total", outcome.durationMs);

    if (decision.status === "ignored") {
        await incrementDailyMetric("listings_ignored");
    }

    // Chỉ tin đủ tiêu chuẩn mới đi tiếp sang bước soạn bài.
    // Tin cần duyệt sẽ được đẩy tiếp khi người dùng bấm duyệt (Module Telegram).
    if (decision.status === "ready") {
        await enqueueJob({ type: "compose_post", listingId });
    }

    // Tin cần duyệt phải báo ngay: để nằm im trong DB thì người dùng không bao giờ biết
    // mà vào duyệt, và tin đăng phòng để lâu vài tiếng là mất giá trị.
    if (decision.status === "needs_review") {
        const updated = await listings().findOne({ _id: listingId });
        if (updated) await notifyNeedsReview(updated as ListingDoc, decision.reason);
    }

    // Báo phòng vừa bóc tách được — CHỈ với tin đi tiếp. Tin `ignored` chiếm phần lớn lưu lượng
    // nhóm Zalo (trò chuyện, banner hoa hồng, tuyển CTV); báo hết thì Telegram thành spam và
    // người dùng bắt đầu bỏ qua cả thông báo quan trọng. Tin `needs_review` đã báo ở trên rồi.
    if (decision.status === "ready") {
        await notifyExtracted({ ...listing, parsed_data: outcome.parsedData, images } as ListingDoc);
    }

    log.info(
        {
            listing_id: listingId,
            is_listing: outcome.result.is_listing,
            confidence: outcome.result.confidence,
            status: decision.status,
            reason: decision.reason,
            images_sent: outcome.imagesSent,
            batch_size: outcome.batchSize,
            duration_ms: outcome.durationMs,
            tokens: outcome.usage,
        },
        "Đã trích xuất xong",
    );

    await completeJob(job._id as ObjectId);
}

async function handleFailure(job: JobDoc, error: unknown): Promise<void> {
    const backoff = backoffDelay(job.attempts, RETRY_BASE_MS, RETRY_MAX_MS);
    const verdict = await failJob(job, error, backoff);
    const message = error instanceof Error ? error.message : String(error);

    await listings().updateOne(
        { _id: job.payload.listing_id },
        { $set: { "extraction_meta.last_error": message, "extraction_meta.attempts": job.attempts } },
    );

    if (verdict === "failed") {
        await setStatus(job.payload.listing_id, "failed", `Trích xuất thất bại: ${message}`);
        log.error({ listing_id: job.payload.listing_id, err: error }, "Trích xuất thất bại hẳn, cần xem lại");
    } else {
        // Đưa listing về received để nếu người dùng chạy lại tay thì trạng thái vẫn nhất quán.
        await setStatus(job.payload.listing_id, "received", `Sẽ thử lại sau ${Math.round(backoff / 1000)}s`);
        log.warn({ listing_id: job.payload.listing_id, backoff_ms: backoff, err: message }, "Sẽ thử trích xuất lại");
    }
}

export interface ExtractionBatchOptions {
    maxSize: number;
    windowMs: number;
    shouldStop: () => boolean;
}

/**
 * Nhận một lô job và trích xuất cả lô bằng MỘT lần gọi Gemini.
 *
 * Trả về số job đã xử lý (0 = hàng đợi rỗng, vòng lặp nên nghỉ).
 *
 * Có hai tầng lỗi, cố ý tách bạch:
 * - Cả lần gọi hỏng (mạng, hết hạn ngạch, JSON không đọc được) -> MỌI job trong lô thử lại.
 *   Lô sau gom lại có thể khác thành phần, không sao: mỗi job vẫn giữ nguyên số lượt của mình.
 * - Chỉ một tin hỏng (model bỏ sót, sai schema riêng tin đó) -> chỉ job đó thử lại, các tin
 *   còn lại đã ghi xong vẫn đi tiếp bình thường. Đây là điều kiện tiên quyết để dám gom lô:
 *   một tin xấu không được kéo theo bốn tin tốt cùng hỏng.
 */
export async function runExtractionBatch(options: ExtractionBatchOptions): Promise<number> {
    const jobs = await collectJobBatch({
        type: "extract_listing",
        maxSize: options.maxSize,
        windowMs: options.windowMs,
        pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
        shouldStop: options.shouldStop,
    });

    if (jobs.length === 0) return 0;

    const pairs: Array<{ job: JobDoc; listing: ListingDoc }> = [];

    for (const job of jobs) {
        const listing = (await listings().findOne({ _id: job.payload.listing_id })) as ListingDoc | null;

        if (!listing) {
            // Listing bị xoá tay trong lúc job còn nằm trong hàng đợi — không có gì để làm.
            log.warn({ listing_id: job.payload.listing_id }, "Không tìm thấy listing, bỏ qua job");
            await completeJob(job._id as ObjectId);
            continue;
        }

        pairs.push({ job, listing });
    }

    if (pairs.length === 0) return jobs.length;

    for (const { listing } of pairs) {
        await setStatus(listing._id as ObjectId, "extracting", null);
    }

    let outcomes;
    try {
        outcomes = await extractListings(pairs.map((pair) => pair.listing));
    } catch (error) {
        for (const { job } of pairs) {
            await handleFailure(job, error);
        }
        log.error({ err: error, batch_size: pairs.length }, "Cả lô trích xuất thất bại, sẽ thử lại từng job");
        return jobs.length;
    }

    for (const [position, { job, listing }] of pairs.entries()) {
        const item = outcomes[position];

        if (!item || !item.ok) {
            await handleFailure(job, item?.error ?? new Error("Thiếu kết quả cho tin này trong lô"));
            continue;
        }

        try {
            await applyOutcome(job, listing, item.outcome);
        } catch (error) {
            await handleFailure(job, error);
        }
    }

    if (pairs.length > 1) {
        log.info(
            { batch_size: pairs.length, gemini_calls_saved: pairs.length - 1 },
            "Đã trích xuất cả lô bằng một lần gọi Gemini",
        );
    }

    return jobs.length;
}

/** Xử lý đúng một job, không chờ gom lô — dùng cho script chạy tay và kiểm thử. */
export async function runExtractionOnce(): Promise<boolean> {
    return (await runExtractionBatch({ maxSize: 1, windowMs: 0, shouldStop: () => false })) > 0;
}

/**
 * Vòng lặp worker. Khi vừa xử lý xong một job thì quét tiếp ngay lập tức
 * (hàng đợi đang có việc), chỉ nghỉ khi hàng đợi rỗng.
 */
export function startExtractionWorker(shouldStop: () => boolean): { stopped: Promise<void> } {
    if (!isGeminiConfigured()) {
        log.warn("Chưa có GEMINI_API_KEY — worker trích xuất không chạy. Tin nhắn Zalo vẫn được lưu lại bình thường.");
        return { stopped: Promise.resolve() };
    }

    const stopped = (async () => {
        log.info(
            {
                model: env.GEMINI_EXTRACTION_MODEL,
                batch_size: env.EXTRACTION_BATCH_SIZE,
                batch_window_s: Math.round(env.LLM_BATCH_WINDOW_MS / 1000),
            },
            "Worker trích xuất bắt đầu chạy",
        );

        while (!shouldStop()) {
            let processed = 0;

            try {
                processed = await runExtractionBatch({
                    maxSize: env.EXTRACTION_BATCH_SIZE,
                    windowMs: env.LLM_BATCH_WINDOW_MS,
                    shouldStop,
                });
            } catch (error) {
                // Lỗi ở tầng hàng đợi (mất kết nối Mongo...) không được phép giết vòng lặp.
                log.error({ err: error }, "Lỗi ngoài dự kiến trong worker trích xuất");
            }

            if (processed === 0) {
                await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_INTERVAL_MS));
            }
        }

        log.info("Worker trích xuất đã dừng");
    })();

    return { stopped };
}
