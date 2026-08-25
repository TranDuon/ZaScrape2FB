import { ObjectId } from "mongodb";
import { env } from "../config/env.js";
import { APP_STATE_ID } from "../config/constants.js";
import { appState, groups, listings, postHistory, postJobs } from "../db/collections.js";
import { incrementDailyMetric } from "../db/indexes.js";
import { checkSession, newPage } from "../facebook/fbBrowser.js";
import { CheckpointError, postToGroup } from "../facebook/fbPoster.js";
import { checkPostingAllowed, recordSuccessfulPost } from "../facebook/rateLimiter.js";
import type { GroupDoc } from "../models/group.model.js";
import type { JobDoc } from "../models/job.model.js";
import type { ListingDoc, ListingStatus } from "../models/listing.model.js";
import type { PostHistoryStatus } from "../models/postHistory.model.js";
import { backoffDelay } from "../utils/delay.js";
import { childLogger } from "../utils/logger.js";
import { listingLabel } from "../notifier/notifyEvents.js";
import { claimNextJob, completeJob, failJob } from "./jobQueue.js";

const log = childLogger("jobs:posting");

const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;

export type NotifyFn = (message: string) => Promise<void> | void;

/**
 * Ngắt cầu dao Facebook.
 *
 * KHÔNG bao giờ tự mở lại. Cầu dao ngắt nghĩa là Facebook đã nghi ngờ tài khoản;
 * tự động thử lại sau vài phút là cách chắc chắn nhất để chuyển từ "bị nghi ngờ"
 * sang "bị khoá". Chỉ người dùng mới được mở lại, sau khi tự kiểm tra tài khoản.
 */
async function tripCircuitBreaker(
    reason: string,
    notify: NotifyFn,
    screenshotPath: string | null = null,
): Promise<void> {
    const now = new Date();

    await appState().updateOne(
        { _id: APP_STATE_ID },
        {
            $set: {
                "circuit_breaker.tripped": true,
                "circuit_breaker.tripped_at": now,
                "circuit_breaker.reason": reason,
                "circuit_breaker.resume_requires_manual_ack": true,
                updated_at: now,
            },
        },
    );

    log.error({ reason, screenshot: screenshotPath }, "ĐÃ NGẮT CẦU DAO FACEBOOK — dừng toàn bộ việc đăng bài");

    // Nói rõ việc cần làm, không chỉ báo lỗi: lúc nhận tin này người dùng đang làm việc khác
    // và cần biết ngay phải xử lý thế nào.
    const lines = [
        "🛑 ĐÃ DỪNG ĐĂNG BÀI LÊN FACEBOOK",
        "",
        reason,
        screenshotPath ? `\nẢnh chụp màn hình: ${screenshotPath}` : "",
        "",
        "Việc cần làm:",
        "1. Mở Facebook bằng tay, kiểm tra tài khoản có bị hạn chế gì không",
        "2. Xử lý xong xuôi thì gõ /resume để chạy lại",
        "",
        "Agent sẽ KHÔNG tự thử lại cho tới khi bạn xác nhận.",
    ];

    await notify(lines.filter(Boolean).join("\n"));
}

async function setListingStatus(listingId: ObjectId, status: ListingStatus, note: string): Promise<void> {
    const now = new Date();
    await listings().updateOne(
        { _id: listingId },
        { $set: { status, updated_at: now }, $push: { status_history: { status, at: now, note } } },
    );
}

/**
 * Cập nhật trạng thái tổng của listing sau khi một job đăng kết thúc.
 *
 * Chỉ chốt khi KHÔNG còn job nào chưa xong. Coi là `posted` nếu có ít nhất một group
 * thành công — đăng được một nơi vẫn là đăng được, không nên đánh dấu thất bại chỉ vì
 * vài group khác lỗi.
 */
async function updateListingProgress(listingId: ObjectId): Promise<void> {
    const rows = await postJobs()
        .aggregate<{ _id: string; n: number }>([
            { $match: { "payload.listing_id": listingId, type: "post_to_group" } },
            { $group: { _id: "$status", n: { $sum: 1 } } },
        ])
        .toArray();

    const counts = Object.fromEntries(rows.map((row) => [row._id, row.n]));
    const unfinished = (counts.pending ?? 0) + (counts.claimed ?? 0) + (counts.processing ?? 0);

    if (unfinished > 0) return;

    const succeeded = counts.done ?? 0;
    const failed = counts.failed ?? 0;

    if (succeeded > 0) {
        await setListingStatus(listingId, "posted", `Đăng thành công ${succeeded} group, thất bại ${failed}`);
    } else if (failed > 0) {
        await setListingStatus(listingId, "failed", `Không đăng được lên group nào (${failed} lần thất bại)`);
    }
}

async function writeHistory(
    job: JobDoc,
    groupId: ObjectId,
    status: PostHistoryStatus,
    extra: { fbPostUrl?: string | null; error?: string | null; screenshot?: string | null; durationMs?: number | null },
): Promise<ObjectId> {
    const result = await postHistory().insertOne({
        listing_id: job.payload.listing_id,
        group_id: groupId,
        job_id: job._id as ObjectId,
        status,
        fb_post_url: extra.fbPostUrl ?? null,
        error_message: extra.error ?? null,
        screenshot_path: extra.screenshot ?? null,
        duration_ms: extra.durationMs ?? null,
        posted_at: new Date(),
    });

    return result.insertedId;
}

async function processJob(job: JobDoc, notify: NotifyFn): Promise<void> {
    const listingId = job.payload.listing_id;
    const groupId = job.payload.group_id;

    if (!groupId) {
        await failJob(job, new Error("Job đăng bài thiếu group_id"), 0);
        return;
    }

    const group = (await groups().findOne({ _id: groupId })) as GroupDoc | null;
    const listing = (await listings().findOne({ _id: listingId })) as ListingDoc | null;

    if (!group || !listing) {
        log.warn({ listing_id: listingId, group_id: groupId }, "Không tìm thấy group hoặc listing, bỏ qua job");
        await completeJob(job._id as ObjectId);
        await updateListingProgress(listingId);
        return;
    }

    const gate = await checkPostingAllowed(group);
    if (!gate.allowed) {
        log.info({ group: group.name, reason: gate.reason }, "Chưa được phép đăng, hoãn lại");
        await writeHistory(job, groupId, "skipped", { error: gate.reason });

        if (gate.retryAt) {
            // Hoãn chứ không tính là một lần thất bại: job vẫn hợp lệ, chỉ chưa tới lúc.
            await postJobs().updateOne(
                { _id: job._id },
                {
                    $set: {
                        status: "pending",
                        scheduled_at: gate.retryAt,
                        claimed_at: null,
                        claimed_by: null,
                        last_error: gate.reason,
                        updated_at: new Date(),
                    },
                    $inc: { attempts: -1 },
                },
            );
        } else {
            await failJob(job, new Error(gate.reason), RETRY_BASE_MS);
        }
        return;
    }

    const composedText = job.payload.composed_text;
    if (!composedText) {
        await failJob(job, new Error("Job không có nội dung đã soạn (composed_text rỗng)"), 0);
        return;
    }

    if (listing.status !== "posting") {
        await setListingStatus(listingId, "posting", `Bắt đầu đăng lên "${group.name}"`);
    }

    const page = await newPage();
    const session = await checkSession(page);

    if (!session.loggedIn) {
        // Phiên hỏng thì mọi job sau cũng hỏng — ngắt cầu dao thay vì thử từng cái một.
        await writeHistory(job, groupId, "failed", { error: session.reason });
        await failJob(job, new Error(session.reason), RETRY_BASE_MS);
        await tripCircuitBreaker(`Phiên Facebook không dùng được: ${session.reason}`, notify);
        return;
    }

    // Ghi "đang thử" TRƯỚC khi thao tác. Nếu tiến trình chết giữa chừng, bản ghi treo ở
    // trạng thái này là dấu hiệu "có thể đã đăng rồi" — phải để người dùng tự kiểm tra
    // chứ không được tự đăng lại, tránh đăng trùng bài lên cùng một nhóm.
    const historyId = await writeHistory(job, groupId, "attempting", {});

    try {
        const outcome = await postToGroup(page, {
            groupUrl: group.url,
            text: composedText,
            images: listing.images,
        });

        await postHistory().updateOne(
            { _id: historyId },
            {
                $set: {
                    status: "success",
                    fb_post_url: outcome.postUrl,
                    duration_ms: outcome.durationMs,
                },
            },
        );

        await recordSuccessfulPost(group);
        await incrementDailyMetric("posts_success");
        await incrementDailyMetric("posting_count");
        await incrementDailyMetric("posting_time_ms_total", outcome.durationMs);
        await completeJob(job._id as ObjectId);
        await updateListingProgress(listingId);

        log.info(
            {
                listing_id: listingId,
                group: group.name,
                images: outcome.imagesUploaded,
                duration_ms: outcome.durationMs,
            },
            "Đã đăng bài thành công",
        );

        // Kèm nhãn phòng: một phòng đăng lên nhiều nhóm và nhiều phòng chạy xen kẽ trong ngày,
        // nên thông báo chỉ có tên nhóm thì không biết bài vừa lên là phòng nào.
        await notify(`✅ Đã đăng ${listingLabel(listing)}
   lên nhóm "${group.name}" (${outcome.imagesUploaded} ảnh)`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (error instanceof CheckpointError) {
            await postHistory().updateOne(
                { _id: historyId },
                { $set: { status: "checkpoint_blocked", error_message: message, screenshot_path: error.screenshotPath } },
            );

            // Không retry: bài có thể đã đăng một phần, và quan trọng hơn là phải dừng ngay.
            await postJobs().updateOne(
                { _id: job._id },
                { $set: { status: "failed", finished_at: new Date(), last_error: message, updated_at: new Date() } },
            );

            await incrementDailyMetric("posts_failed");
            await tripCircuitBreaker(message, notify, error.screenshotPath);
            await updateListingProgress(listingId);
            return;
        }

        await postHistory().updateOne({ _id: historyId }, { $set: { status: "failed", error_message: message } });
        await incrementDailyMetric("posts_failed");

        const backoff = backoffDelay(job.attempts, RETRY_BASE_MS, RETRY_MAX_MS);
        const verdict = await failJob(job, error, backoff);

        if (verdict === "failed") {
            log.error({ listing_id: listingId, group: group.name, err: message }, "Đăng bài thất bại hẳn");
            await notify(`⚠️ Không đăng được ${listingLabel(listing)}
   lên nhóm "${group.name}": ${message}`);
            await updateListingProgress(listingId);
        } else {
            log.warn({ group: group.name, backoff_ms: backoff, err: message }, "Sẽ thử đăng lại");
        }
    }
}

export async function runPostingOnce(notify: NotifyFn): Promise<boolean> {
    const state = await appState().findOne({ _id: APP_STATE_ID });
    if (state?.circuit_breaker.tripped) return false;

    const job = await claimNextJob("post_to_group");
    if (!job) return false;

    try {
        await processJob(job, notify);
    } catch (error) {
        log.error({ err: error }, "Lỗi ngoài dự kiến khi đăng bài");
        await failJob(job, error, RETRY_BASE_MS);
    }

    return true;
}

/**
 * Vòng lặp đăng bài.
 *
 * Khác với các worker kia: sau mỗi bài đăng thành công LUÔN nghỉ trọn một chu kỳ,
 * không quét tiếp ngay. Đăng liên tiếp nhiều bài trong vài giây là dấu hiệu bot rõ nhất,
 * và scheduler ở giai đoạn sau còn siết thêm nữa.
 */
export function startPostingWorker(shouldStop: () => boolean, notify: NotifyFn): { stopped: Promise<void> } {
    const stopped = (async () => {
        log.info(
            {
                max_per_day: env.MAX_POSTS_PER_DAY,
                active_hours: `${env.ACTIVE_HOURS_START}h-${env.ACTIVE_HOURS_END}h`,
                headless: env.FB_HEADLESS,
            },
            "Worker đăng bài bắt đầu chạy",
        );

        while (!shouldStop()) {
            try {
                await runPostingOnce(notify);
            } catch (error) {
                log.error({ err: error }, "Lỗi ngoài dự kiến trong worker đăng bài");
            }

            await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_INTERVAL_MS));
        }

        log.info("Worker đăng bài đã dừng");
    })();

    return { stopped };
}
