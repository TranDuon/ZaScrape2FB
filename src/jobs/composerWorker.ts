import type { ObjectId } from "mongodb";
import { env } from "../config/env.js";
import { dailyMetrics, groups, listings } from "../db/collections.js";
import { incrementDailyMetric } from "../db/indexes.js";
import { matchGroupsToArea } from "../facebook/areaMatcher.js";
import { composePosts, type ComposeOutcome, type PostVariation } from "../llm/composer.js";
import { isGeminiConfigured } from "../llm/geminiClient.js";
import type { GroupDoc } from "../models/group.model.js";
import type { JobDoc } from "../models/job.model.js";
import type { ListingDoc, ListingStatus } from "../models/listing.model.js";
import { backoffDelay, randomInt } from "../utils/delay.js";
import { childLogger } from "../utils/logger.js";
import { businessDateKey } from "../utils/time.js";
import { collectJobBatch } from "./batchCollector.js";
import { completeJob, deferJob, enqueueJob, failJob } from "./jobQueue.js";

const log = childLogger("jobs:composer");

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60 * 1000;

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
 * Các group đủ điều kiện nhận bài ngay lúc này.
 *
 * Lọc sơ bộ theo hạn mức ngày ở đây để không tạo ra job chắc chắn sẽ bị bỏ qua.
 * Việc kiểm tra khoảng cách tối thiểu giữa hai lần đăng thuộc về scheduler, vì lúc job
 * thực sự chạy thì `last_posted_at` đã khác so với lúc tạo job.
 */
async function eligibleGroups(): Promise<GroupDoc[]> {
    const active = await groups().find({ active: true }).sort({ created_at: 1 }).toArray();

    return active.filter((group) => group.posts_today_count < group.post_frequency.max_posts_per_day);
}

/**
 * Số tin được phép soạn bài trong một ngày.
 *
 * Suy thẳng ra từ năng lực đăng thật: mỗi tin chiếm `MAX_GROUPS_PER_LISTING` lượt đăng, mà cả
 * ngày chỉ có `MAX_POSTS_PER_DAY` lượt. Soạn nhiều hơn con số này là trả tiền Gemini cho những
 * bài chắc chắn không kịp lên Facebook trong ngày — và vì job `pending` không có TTL, chúng còn
 * dồn lại vô hạn trong `post_jobs` cho tới lúc chạm trần 512MB của Atlas M0.
 */
function dailyComposeBudget(): number {
    return Math.max(1, Math.floor(env.MAX_POSTS_PER_DAY / env.MAX_GROUPS_PER_LISTING));
}

async function composedToday(): Promise<number> {
    const doc = await dailyMetrics().findOne({ _id: businessDateKey() });
    return doc?.compose_count ?? 0;
}

/** Đầu khung giờ đăng của ngày mai, theo giờ VN — mốc sớm nhất một tin bị hoãn có thể chạy lại. */
function nextActiveWindowStart(): Date {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const key = businessDateKey(tomorrow);
    // Chuỗi ISO kèm offset +07:00 để mốc này là giờ VN thật, không phụ thuộc giờ hệ thống VPS.
    return new Date(`${key}T${String(env.ACTIVE_HOURS_START).padStart(2, "0")}:00:00+07:00`);
}

/**
 * Chọn tối đa `MAX_GROUPS_PER_LISTING` nhóm trong số nhóm khớp khu vực.
 *
 * Hai tiêu chí, xét theo thứ tự:
 *
 * 1. **Đã dùng bao nhiêu lần TRONG CHÍNH LÔ NÀY.** `last_posted_at` chỉ đổi khi bài thật sự lên
 *    Facebook (muộn hơn nhiều), nên trong lúc soạn cả lô nó là hằng số — không đếm riêng thì 5
 *    phòng cùng quận sẽ chọn ĐÚNG một nhóm giống hệt nhau, dồn cả 5 bài vào một chỗ trong khi 28
 *    nhóm còn lại nằm không. Với MAX_GROUPS_PER_LISTING=1 thì lỗi này lộ rõ nhất.
 * 2. **Lâu chưa đăng nhất.** Lấy N nhóm đầu danh sách thì vài nhóm đầu bị dội bài mỗi ngày còn
 *    phần còn lại không bao giờ được dùng — vừa phí độ phủ, vừa đúng kiểu hành vi khiến một tài
 *    khoản bị chính các nhóm đó report.
 */
function pickLeastRecentlyUsed(matched: GroupDoc[], limit: number, usedInBatch: Map<string, number>): GroupDoc[] {
    const picked = [...matched]
        .sort((a, b) => {
            const usedA = usedInBatch.get((a._id as ObjectId).toHexString()) ?? 0;
            const usedB = usedInBatch.get((b._id as ObjectId).toHexString()) ?? 0;
            if (usedA !== usedB) return usedA - usedB;
            return (a.last_posted_at?.getTime() ?? 0) - (b.last_posted_at?.getTime() ?? 0);
        })
        .slice(0, limit);

    for (const group of picked) {
        const key = (group._id as ObjectId).toHexString();
        usedInBatch.set(key, (usedInBatch.get(key) ?? 0) + 1);
    }

    return picked;
}

/**
 * Gán biến thể cho từng group.
 *
 * Khi số group nhiều hơn số biến thể, buộc phải dùng lại — nhưng xáo trộn thứ tự để hai
 * group cạnh nhau trong danh sách không nhận cùng một nội dung.
 */
function assignVariations(groupCount: number, variations: PostVariation[]): PostVariation[] {
    const shuffled = [...variations];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randomInt(0, i);
        [shuffled[i], shuffled[j]] = [shuffled[j] as PostVariation, shuffled[i] as PostVariation];
    }

    return Array.from({ length: groupCount }, (_, index) => shuffled[index % shuffled.length] as PostVariation);
}

/**
 * Mốc thời gian cho từng group, cộng dồn ngẫu nhiên.
 *
 * Đăng cùng một tin lên nhiều group trong vài giây là dấu hiệu bot rõ ràng nhất.
 * Scheduler còn siết thêm (mỗi tick một job, chỉ trong khung giờ hoạt động), nhưng
 * giãn cách ngay từ lúc tạo job giúp thứ tự đăng không bị dồn cục.
 *
 * `startOffsetMinutes` cho phép cộng dồn XUYÊN SUỐT cả lô: soạn 3 phòng một lượt mà mỗi phòng
 * lại đếm lại từ 0 thì bài của ba phòng chồng lên nhau ngay trong cùng vài phút đầu — đúng thứ
 * mà việc giãn cách sinh ra để tránh. Trả kèm mốc cuối để phòng kế tiếp nối tiếp từ đó.
 */
function staggeredSchedule(groupCount: number, startOffsetMinutes: number): { times: Date[]; nextOffset: number } {
    const now = Date.now();
    const times: Date[] = [];
    let offsetMinutes = startOffsetMinutes;

    for (let index = 0; index < groupCount; index++) {
        offsetMinutes += randomInt(env.COMPOSE_STAGGER_MIN_MINUTES, env.COMPOSE_STAGGER_MAX_MINUTES);
        times.push(new Date(now + offsetMinutes * 60_000));
    }

    return { times, nextOffset: offsetMinutes };
}

/**
 * Ghi bài đã soạn của MỘT phòng và tạo job đăng cho từng group.
 *
 * Tách khỏi phần gọi Gemini vì một lần gọi giờ phục vụ cả lô. Trả về mốc giãn cách cuối cùng
 * để phòng kế tiếp trong lô nối tiếp từ đó thay vì đếm lại từ đầu.
 */
async function applyOutcome(
    job: JobDoc,
    listing: ListingDoc,
    outcome: ComposeOutcome,
    targets: GroupDoc[],
    startOffsetMinutes: number,
): Promise<number> {
    const listingId = listing._id as ObjectId;
    const assigned = assignVariations(targets.length, outcome.variations);
    const { times: schedule, nextOffset } = staggeredSchedule(targets.length, startOffsetMinutes);
    const now = new Date();

    // Biến thể đầu tiên là bản gốc người dùng xem/sửa qua Telegram.
    const canonical = outcome.variations[0] as PostVariation;

    await listings().updateOne(
        { _id: listingId },
        {
            $set: {
                composed_post: {
                    text: canonical.fullText,
                    hashtags: canonical.hashtags,
                    generated_at: now,
                    model: outcome.model,
                    edited_by_user: false,
                },
                target_group_ids: targets.map((group) => group._id as ObjectId),
                status: "queued",
                updated_at: now,
            },
            $push: {
                status_history: {
                    status: "queued" as ListingStatus,
                    at: now,
                    note: `Đã soạn ${outcome.variations.length} biến thể cho ${targets.length} group`,
                },
            },
        },
    );

    let created = 0;
    for (const [index, group] of targets.entries()) {
        const variation = assigned[index] as PostVariation;

        const postJob = await enqueueJob({
            type: "post_to_group",
            listingId,
            groupId: group._id as ObjectId,
            // Snapshot bất biến: worker đăng bài luôn dùng đúng chuỗi này, không đọc lại
            // listing lúc đăng — nội dung lên Facebook khớp chính xác thứ đã được duyệt.
            composedText: variation.fullText,
            scheduledAt: schedule[index] as Date,
        });

        if (postJob) created++;
    }

    log.info(
        {
            listing_id: listingId,
            groups: targets.length,
            variations: outcome.variations.length,
            jobs_created: created,
            first_run_at: schedule[0]?.toLocaleString("vi-VN", { timeZone: env.TZ }),
            last_run_at: schedule[schedule.length - 1]?.toLocaleString("vi-VN", { timeZone: env.TZ }),
            duration_ms: outcome.durationMs,
            tokens: outcome.usage,
            batch_size: outcome.batchSize,
        },
        "Đã soạn bài và xếp lịch đăng",
    );

    await incrementDailyMetric("compose_count");
    await completeJob(job._id as ObjectId);
    return nextOffset;
}

async function handleFailure(job: JobDoc, error: unknown): Promise<void> {
    const backoff = backoffDelay(job.attempts, RETRY_BASE_MS, RETRY_MAX_MS);
    const verdict = await failJob(job, error, backoff);
    const message = error instanceof Error ? error.message : String(error);

    if (verdict === "failed") {
        await setStatus(job.payload.listing_id, "failed", `Soạn bài thất bại: ${message}`);
        log.error({ listing_id: job.payload.listing_id, err: error }, "Soạn bài thất bại hẳn");
    } else {
        // Giữ ở `ready` để lần thử lại đi đúng đường: listing vẫn đang chờ được soạn bài.
        await setStatus(job.payload.listing_id, "ready", `Sẽ soạn lại sau ${Math.round(backoff / 1000)}s`);
        log.warn({ listing_id: job.payload.listing_id, backoff_ms: backoff, err: message }, "Sẽ thử soạn bài lại");
    }
}

export interface ComposerBatchOptions {
    maxSize: number;
    windowMs: number;
    shouldStop: () => boolean;
}

/**
 * Nhận một lô job và soạn bài cho cả lô bằng MỘT lần gọi Gemini.
 *
 * Trả về số job đã xử lý (0 = hàng đợi rỗng, vòng lặp nên nghỉ).
 *
 * Hạn mức ngày của group được lọc MỘT lần cho cả lô (`posts_today_count` chỉ đổi khi bài thật sự
 * được đăng, muộn hơn nhiều), nhưng KHU VỰC thì phải xét theo TỪNG phòng — mỗi phòng một quận
 * khác nhau. Vì vậy số group đích khác nhau giữa các phòng, và số biến thể yêu cầu Gemini lấy
 * theo phòng cần nhiều nhất; phòng cần ít hơn chỉ dùng phần đầu, thừa vài biến thể không sao.
 *
 * Phòng không khớp nhóm nào bị loại khỏi lô TRƯỚC khi gọi Gemini — soạn bài cho một phòng chắc
 * chắn không đăng được ở đâu là ném thẳng một lượt hạn ngạch đi.
 */
export async function runComposerBatch(options: ComposerBatchOptions): Promise<number> {
    const jobs = await collectJobBatch({
        type: "compose_post",
        maxSize: options.maxSize,
        windowMs: options.windowMs,
        pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
        shouldStop: options.shouldStop,
        // Tin mới nhất trước: có tồn đọng thì phòng cũ đã ế, soạn bài cho nó là phí một suất đăng.
        order: "newest_first",
    });

    if (jobs.length === 0) return 0;

    const pairs: Array<{ job: JobDoc; listing: ListingDoc }> = [];

    for (const job of jobs) {
        const listing = (await listings().findOne({ _id: job.payload.listing_id })) as ListingDoc | null;

        if (!listing) {
            log.warn({ listing_id: job.payload.listing_id }, "Không tìm thấy listing, bỏ qua job");
            await completeJob(job._id as ObjectId);
            continue;
        }

        pairs.push({ job, listing });
    }

    if (pairs.length === 0) return jobs.length;

    const available = await eligibleGroups();

    if (available.length === 0) {
        // Không có group nào nhận bài: giữ listing ở `ready` để lần soạn sau vẫn chạy được,
        // thay vì đẩy sang `queued` rồi mắc kẹt ở đó vì chẳng có job đăng nào. Không gọi Gemini —
        // soạn bài lúc này chắc chắn phí một lượt hạn ngạch.
        for (const { job, listing } of pairs) {
            await setStatus(listing._id as ObjectId, "ready", "Chưa có group nào đủ điều kiện nhận bài");
            await completeJob(job._id as ObjectId);
        }

        log.warn({ jobs: pairs.length }, "Không có group active còn hạn mức hôm nay");
        return jobs.length;
    }

    // Ngân sách soạn bài trong ngày: chốt TRƯỚC khi gọi Gemini, vì đây chính là chỗ tiền được
    // tiêu. Hết ngân sách thì hoãn sang đầu khung giờ ngày mai chứ không bỏ tin.
    const budget = dailyComposeBudget();
    let remaining = budget - (await composedToday());

    if (remaining <= 0) {
        const until = nextActiveWindowStart();
        for (const { job } of pairs) {
            await deferJob(job, until, `Đã dùng hết ngân sách soạn bài hôm nay (${budget} tin)`);
        }
        log.info(
            { budget, deferred: pairs.length, until: until.toLocaleString("vi-VN", { timeZone: env.TZ }) },
            "Hết ngân sách soạn bài hôm nay — hoãn sang ngày mai, không tốn hạn ngạch Gemini",
        );
        return jobs.length;
    }

    // Ghép khu vực theo TỪNG phòng, và loại phòng không khớp nhóm nào ra khỏi lô trước khi
    // tốn một lượt gọi Gemini cho nó.
    const targeted: Array<{ job: JobDoc; listing: ListingDoc; targets: GroupDoc[] }> = [];
    // Đếm số lần mỗi nhóm đã được chọn trong lô này, để rải bài ra thay vì dồn một chỗ.
    const usedInBatch = new Map<string, number>();

    for (const { job, listing } of pairs) {
        if (remaining <= 0) {
            const until = nextActiveWindowStart();
            await deferJob(job, until, `Đã dùng hết ngân sách soạn bài hôm nay (${budget} tin)`);
            continue;
        }

        const address = listing.parsed_data?.address ?? { district: null, ward: null, raw: null };
        const match = matchGroupsToArea(available, address);

        if (match.unknownAreaGroups.length > 0) {
            log.warn(
                { groups: match.unknownAreaGroups },
                "Không suy được khu vực từ tên nhóm — khai báo tay trường `areas` cho nhóm này, nếu không nó sẽ không bao giờ nhận bài",
            );
        }

        if (match.matched.length === 0) {
            const reason =
                match.listingDistricts.length === 0
                    ? "Không xác định được quận của phòng — không đăng để tránh sai khu vực"
                    : `Không có nhóm nào phủ khu vực ${match.listingDistricts.join(", ")}`;

            await setStatus(listing._id as ObjectId, "ready", reason);
            await completeJob(job._id as ObjectId);
            log.warn({ listing_id: listing._id, districts: match.listingDistricts }, reason);
            continue;
        }

        // Chặn số nhóm mỗi tin: một tin khớp 10 nhóm mà đăng cả 10 thì ăn hết nửa hạn mức ngày,
        // và cùng một nội dung xuất hiện ở 10 nơi là dấu hiệu spam rõ nhất với Facebook.
        const targets = pickLeastRecentlyUsed(match.matched, env.MAX_GROUPS_PER_LISTING, usedInBatch);

        targeted.push({ job, listing, targets });
        remaining--;
    }

    if (targeted.length === 0) return jobs.length;

    // Số biến thể lấy theo phòng cần nhiều nhóm nhất — phòng ít nhóm hơn chỉ dùng phần đầu.
    // Mỗi phòng xin ĐÚNG số bài bằng số nhóm của nó. Dùng chung con số lớn nhất của lô là bắt
    // model viết thừa cho phòng ít nhóm — output chính là phần đắt nhất của bước soạn bài.
    let outcomes;
    try {
        outcomes = await composePosts(
            targeted.map((item) => item.listing),
            targeted.map((item) => item.targets.length),
        );
    } catch (error) {
        for (const { job } of targeted) {
            await handleFailure(job, error);
        }
        log.error({ err: error, batch_size: targeted.length }, "Cả lô soạn bài thất bại, sẽ thử lại từng job");
        return jobs.length;
    }

    // Giãn cách chạy nối tiếp qua từng phòng trong lô, không reset về 0 ở mỗi phòng.
    let offsetMinutes = 0;

    for (const [position, { job, listing, targets }] of targeted.entries()) {
        const item = outcomes[position];

        if (!item || !item.ok) {
            await handleFailure(job, item?.error ?? new Error("Thiếu kết quả cho phòng này trong lô"));
            continue;
        }

        try {
            offsetMinutes = await applyOutcome(job, listing, item.outcome, targets, offsetMinutes);
        } catch (error) {
            await handleFailure(job, error);
        }
    }

    if (targeted.length > 1) {
        log.info(
            { batch_size: targeted.length, gemini_calls_saved: targeted.length - 1 },
            "Đã soạn bài cả lô bằng một lần gọi Gemini",
        );
    }

    return jobs.length;
}

/** Xử lý đúng một job, không chờ gom lô — dùng cho script chạy tay và kiểm thử. */
export async function runComposerOnce(): Promise<boolean> {
    return (await runComposerBatch({ maxSize: 1, windowMs: 0, shouldStop: () => false })) > 0;
}

export function startComposerWorker(shouldStop: () => boolean): { stopped: Promise<void> } {
    if (!isGeminiConfigured()) {
        log.warn("Chưa có GEMINI_API_KEY — worker soạn bài không chạy.");
        return { stopped: Promise.resolve() };
    }

    const stopped = (async () => {
        log.info(
            {
                model: env.GEMINI_COMPOSER_MODEL,
                batch_size: env.COMPOSE_BATCH_SIZE,
                batch_window_s: Math.round(env.LLM_BATCH_WINDOW_MS / 1000),
            },
            "Worker soạn bài bắt đầu chạy",
        );

        while (!shouldStop()) {
            let processed = 0;

            try {
                processed = await runComposerBatch({
                    maxSize: env.COMPOSE_BATCH_SIZE,
                    windowMs: env.LLM_BATCH_WINDOW_MS,
                    shouldStop,
                });
            } catch (error) {
                log.error({ err: error }, "Lỗi ngoài dự kiến trong worker soạn bài");
            }

            if (processed === 0) {
                await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_INTERVAL_MS));
            }
        }

        log.info("Worker soạn bài đã dừng");
    })();

    return { stopped };
}
