import { APP_STATE_ID } from "../config/constants.js";
import { env } from "../config/env.js";
import { appState, postJobs } from "../db/collections.js";
import { isWithinActiveHours } from "../facebook/rateLimiter.js";
import { runPostingOnce, type NotifyFn } from "../jobs/postingWorker.js";
import { requeueStaleJobs } from "../jobs/jobQueue.js";
import { childLogger } from "../utils/logger.js";
import { businessHour } from "../utils/time.js";

const log = childLogger("scheduler");

/** Job kẹt ở `processing` lâu hơn mức này coi như tiến trình xử lý nó đã chết. */
const STALE_JOB_MS = 15 * 60 * 1000;

export interface CycleResult {
    action: "posted" | "skipped" | "idle";
    reason: string;
}

/**
 * Một nhịp điều phối.
 *
 * Nguyên tắc quan trọng nhất: mỗi nhịp chỉ xử lý ĐÚNG MỘT job đăng bài. Đây là thứ
 * tạo ra khoảng cách thời gian tự nhiên giữa các bài mà không cần chặn event loop
 * bằng sleep — và khoảng cách đó chính là điều giữ cho tài khoản không bị coi là bot.
 */
export async function runCycle(notify: NotifyFn): Promise<CycleResult> {
    const state = await appState().findOne({ _id: APP_STATE_ID });

    if (state?.circuit_breaker.tripped) {
        return { action: "skipped", reason: `Cầu dao ngắt: ${state.circuit_breaker.reason ?? "không rõ"}` };
    }

    if (!isWithinActiveHours()) {
        return {
            action: "skipped",
            reason: `Ngoài khung giờ đăng bài (hiện ${businessHour()}h, cho phép ${env.ACTIVE_HOURS_START}h-${env.ACTIVE_HOURS_END}h)`,
        };
    }

    if ((state?.daily_counters.total_posts_today ?? 0) >= env.MAX_POSTS_PER_DAY) {
        return { action: "skipped", reason: `Đã đủ ${env.MAX_POSTS_PER_DAY} bài hôm nay` };
    }

    // Dọn job của tiến trình đã chết trước khi nhận job mới, nếu không chúng nằm lại mãi.
    const sweep = await requeueStaleJobs(STALE_JOB_MS);
    if (sweep.requeued > 0 || sweep.abandonedPosts > 0) {
        log.warn(sweep, "Đã dọn job bị kẹt của tiến trình chết giữa chừng");
    }

    const didWork = await runPostingOnce(notify);

    return didWork
        ? { action: "posted", reason: "Đã xử lý một job đăng bài" }
        : { action: "idle", reason: "Không có job nào đến hạn" };
}

/** Số job đăng bài đang chờ — dùng cho health check và lệnh /status. */
export async function countPendingPostJobs(): Promise<number> {
    return postJobs().countDocuments({ type: "post_to_group", status: "pending" });
}
