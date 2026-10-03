import { ObjectId } from "mongodb";
import { env } from "../config/env.js";
import { APP_STATE_ID } from "../config/constants.js";
import { appState, groups, listings, postHistory, postJobs } from "../db/collections.js";
import { incrementDailyMetric } from "../db/indexes.js";
import { checkSession, newPage } from "../facebook/fbBrowser.js";
import { CheckpointError, postToGroup } from "../facebook/fbPoster.js";
import { isCarryoverJob, type PostKind } from "../facebook/dailyQuota.js";
import { checkPostingAllowed, recordSuccessfulPost } from "../facebook/rateLimiter.js";
import type { GroupDoc } from "../models/group.model.js";
import type { JobDoc } from "../models/job.model.js";
import type { ListingDoc, ListingStatus } from "../models/listing.model.js";
import type { PostHistoryStatus } from "../models/postHistory.model.js";
import { backoffDelay } from "../utils/delay.js";
import { formatActiveWindows } from "../utils/activeWindows.js";
import { childLogger } from "../utils/logger.js";
import { businessDayStart } from "../utils/time.js";
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

/**
 * Kết quả xử lý một job đăng:
 * - `attempted`: đã chạm tới Facebook (mở trang, kiểm phiên, đăng — thành công hay lỗi đều tính).
 * - `deferred`: dừng TRƯỚC khi đụng Facebook — hoãn vì quy tắc cách nhau/hạn mức nhóm, hoặc job hỏng
 *   dữ liệu. Lượt điều phối này chưa dùng vào việc gì, nên được phép chuyển sang job kế tiếp.
 */
export type JobOutcome = "attempted" | "deferred";

async function processJob(job: JobDoc, notify: NotifyFn): Promise<JobOutcome> {
    const listingId = job.payload.listing_id;
    const groupId = job.payload.group_id;

    if (!groupId) {
        await failJob(job, new Error("Job đăng bài thiếu group_id"), 0);
        return "deferred";
    }

    const group = (await groups().findOne({ _id: groupId })) as GroupDoc | null;
    const listing = (await listings().findOne({ _id: listingId })) as ListingDoc | null;

    if (!group || !listing) {
        log.warn({ listing_id: listingId, group_id: groupId }, "Không tìm thấy group hoặc listing, bỏ qua job");
        await completeJob(job._id as ObjectId);
        await updateListingProgress(listingId);
        return "deferred";
    }

    // Loại bài quyết định dùng suất nào (xem dailyQuota.ts). Tính ngay tại đây từ chính job, không
    // phụ thuộc việc nó được nhặt theo đường nào.
    const kind: PostKind = isCarryoverJob(job.created_at, businessDayStart()) ? "carryover" : "regular";

    const gate = await checkPostingAllowed(group, kind);
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
        return "deferred";
    }

    const composedText = job.payload.composed_text;
    if (!composedText) {
        await failJob(job, new Error("Job không có nội dung đã soạn (composed_text rỗng)"), 0);
        return "deferred";
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
        return "attempted";
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

        // Bài chờ duyệt đi CHUNG nhánh thành công một cách cố ý: thao tác đăng đã trót lọt, job
        // phải kết thúc và tuyệt đối không được đăng lại. Chỉ khác ở chỗ ghi nhận và báo cáo.
        await postHistory().updateOne(
            { _id: historyId },
            {
                $set: {
                    status: outcome.pendingApproval ? "pending_approval" : "success",
                    fb_post_url: outcome.postUrl,
                    duration_ms: outcome.durationMs,
                    note: outcome.pendingApprovalEvidence,
                    screenshot_path: outcome.pendingApprovalScreenshot,
                },
            },
        );

        // Vẫn tính vào hạn mức nhóm lẫn hạn mức ngày: bài chờ duyệt vẫn là một lần thao tác thật
        // với Facebook, vẫn tiêu một suất đăng, và vẫn nằm trong hàng chờ của nhóm.
        await recordSuccessfulPost(group, kind);
        await incrementDailyMetric(outcome.pendingApproval ? "posts_pending_approval" : "posts_success");
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
                pending_approval: outcome.pendingApproval,
                carryover: kind === "carryover",
            },
            outcome.pendingApproval ? "Đã gửi bài, đang chờ quản trị viên duyệt" : "Đã đăng bài thành công",
        );

        // Kèm nhãn phòng: một phòng đăng lên nhiều nhóm và nhiều phòng chạy xen kẽ trong ngày,
        // nên thông báo chỉ có tên nhóm thì không biết bài vừa lên là phòng nào.
        //
        // Hai câu chữ phải khác nhau rõ rệt. "Đã đăng" mà thực ra còn nằm chờ duyệt là báo cáo
        // sai: người dùng mở nhóm ra không thấy bài đâu, và cũng không biết là cần vào chờ duyệt.
        await notify(
            outcome.pendingApproval
                ? `⏳ Đã gửi ${listingLabel(listing)}
   vào nhóm "${group.name}" (${outcome.imagesUploaded} ảnh)
   Nhóm bật kiểm duyệt — bài ĐANG CHỜ quản trị viên duyệt, chưa hiển thị trên nhóm.`
                : `✅ Đã đăng ${listingLabel(listing)}
   lên nhóm "${group.name}" (${outcome.imagesUploaded} ảnh)
   Bài đã hiển thị trên nhóm.`,
        );
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
            return "attempted";
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

    return "attempted";
}

/**
 * Nhặt job nào: `carryover` = chỉ bài tồn (soạn trước 0h hôm nay), `today` = chỉ bài soạn hôm nay,
 * `any` = không phân biệt (script thủ công, worker poll cũ).
 */
export type PostScope = "carryover" | "today" | "any";

/**
 * Số job tối đa được xét trong MỘT lượt khi các job trước đều bị hoãn. Có trần để một lượt không quét
 * cả hàng đợi (mỗi lần hoãn là vài lượt ghi Mongo + một bản ghi post_history "skipped").
 */
const MAX_JOBS_CHECKED_PER_TICK = 6;

/** `idle` = không có job nào đến hạn; `deferred` = có, nhưng tất cả đều phải hoãn. */
export type PostingAttempt = JobOutcome | "idle";

/**
 * Xử lý tối đa MỘT lần đăng thật lên Facebook.
 *
 * Job đến lượt mà bị hoãn (thường là quy tắc cách nhau giữa hai lần đăng vào cùng nhóm) thì nhặt
 * tiếp job đến hạn kế tiếp NGAY trong lượt này. Trước đây lượt đó bị bỏ trống: đo tối 29/9, 2/15
 * lượt trôi qua không đăng gì dù hàng đợi còn bài quá giờ đăng được — nhịp 20 phút là suất đăng khan
 * hiếm nhất của cả hệ thống. Không phá bất biến "một bài mỗi lượt": job bị hoãn chưa hề chạm tới
 * Facebook, và vòng lặp dừng ngay ở job đầu tiên đã chạm (kể cả khi lần đăng đó lỗi — thử liền một
 * bài khác sau một lần lỗi chính là kiểu dồn dập mà nhịp lượt sinh ra để tránh).
 */
export async function runPostingOnce(notify: NotifyFn, scope: PostScope = "any"): Promise<PostingAttempt> {
    const dayStart = businessDayStart();
    const filter =
        scope === "carryover"
            ? { created_at: { $lt: dayStart } }
            : scope === "today"
              ? { created_at: { $gte: dayStart } }
              : {};

    for (let checked = 0; checked < MAX_JOBS_CHECKED_PER_TICK; checked++) {
        // Kiểm lại mỗi vòng: một job vừa xử lý có thể đã ngắt cầu dao.
        const state = await appState().findOne({ _id: APP_STATE_ID });
        if (state?.circuit_breaker.tripped) return checked === 0 ? "idle" : "deferred";

        const job = await claimNextJob("post_to_group", "oldest_first", filter);
        if (!job) return checked === 0 ? "idle" : "deferred";

        let outcome: JobOutcome;
        try {
            outcome = await processJob(job, notify);
        } catch (error) {
            log.error({ err: error }, "Lỗi ngoài dự kiến khi đăng bài");
            await failJob(job, error, RETRY_BASE_MS);
            // Không biết lỗi xảy ra trước hay sau khi chạm Facebook — coi như đã chạm, dừng lượt này.
            outcome = "attempted";
        }

        if (outcome === "attempted") return "attempted";
    }

    return "deferred";
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
                active_hours: formatActiveWindows(env.ACTIVE_WINDOWS),
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
