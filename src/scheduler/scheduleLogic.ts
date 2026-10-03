import { APP_STATE_ID } from "../config/constants.js";
import { env } from "../config/env.js";
import { appState, postJobs } from "../db/collections.js";
import { slotFor } from "../facebook/dailyQuota.js";
import { dailyQuotaLimits, dailyQuotaUsed, isWithinActiveHours } from "../facebook/rateLimiter.js";
import { formatActiveWindows } from "../utils/activeWindows.js";
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
            reason: `Ngoài khung giờ đăng bài (hiện ${businessHour()}h, cho phép ${formatActiveWindows(env.ACTIVE_WINDOWS)})`,
        };
    }

    // Phải đọc qua `dailyQuotaUsed()` (đi qua `postsTodayCount()`) chứ không đọc thẳng
    // `state.daily_counters`: chỉ đường đó mới lật bộ đếm sang ngày mới. Đọc số thô ở đây khiến
    // chốt chặn tự khoá chính nó — số 10/10 của hôm qua chặn luôn đường duy nhất reset nó, và hệ
    // thống ngừng đăng vĩnh viễn.
    const used = await dailyQuotaUsed();
    const limits = dailyQuotaLimits();
    // Bài tồn luôn có ít nhất các suất mà bài thường có (hết suất bù thì rơi xuống suất thường), nên
    // bài tồn hết suất nghĩa là không bài nào còn suất.
    const carryoverAllowed = slotFor("carryover", used, limits) !== null;
    const todayAllowed = slotFor("regular", used, limits) !== null;

    if (!carryoverAllowed) {
        return {
            action: "skipped",
            reason:
                `Đã đủ ${used.regular}/${limits.regular} bài hôm nay` +
                (limits.carryoverExtra > 0 ? ` và ${used.carryover}/${limits.carryoverExtra} suất bù bài tồn` : ""),
        };
    }

    // Dọn job của tiến trình đã chết trước khi nhận job mới, nếu không chúng nằm lại mãi.
    const sweep = await requeueStaleJobs(STALE_JOB_MS);
    if (sweep.requeued > 0 || sweep.abandonedPosts > 0) {
        log.warn(sweep, "Đã dọn job bị kẹt của tiến trình chết giữa chừng");
    }

    // Bài TỒN từ ngày trước đi trước bài soạn hôm nay. Không có ưu tiên này thì bài tồn (thường đã
    // quá giờ vì máy tắt, hoặc bị quy tắc cách nhau giữa hai lần đăng vào cùng nhóm đẩy lùi) phải tranh
    // suất với bài mới, bị đẩy tiếp sang hôm sau, rồi hết hạn ở LISTING_MAX_AGE_DAYS — mất phòng dù
    // đã tốn Gemini soạn bài. Vẫn đúng MỘT lần đăng thật mỗi nhịp: nhánh "today" chỉ chạy khi nhánh
    // bài tồn chưa chạm tới Facebook (không có bài tồn đến hạn, hoặc tất cả đều phải hoãn).
    //
    // Trong mỗi nhánh, bài QUÁ GIỜ luôn được nhặt trước vì hàng đợi xếp theo `scheduled_at` sớm nhất,
    // và bài đến lượt mà phải hoãn không còn làm mất cả nhịp — xem `runPostingOnce`.
    const carryover = await runPostingOnce(notify, "carryover");
    if (carryover === "attempted") {
        return { action: "posted", reason: "Đã xử lý một bài tồn từ ngày trước" };
    }

    if (!todayAllowed) {
        return {
            action: "skipped",
            reason:
                `Đã đủ ${used.regular}/${limits.regular} bài hôm nay; còn ` +
                `${limits.carryoverExtra - used.carryover} suất bù nhưng ` +
                (carryover === "deferred" ? "các bài tồn đến hạn đều đang phải hoãn" : "không có bài tồn nào đến hạn"),
        };
    }

    const today = await runPostingOnce(notify, "today");
    if (today === "attempted") {
        return { action: "posted", reason: "Đã xử lý một job đăng bài" };
    }

    // Có job đến hạn nhưng tất cả đều phải hoãn (thường là quy tắc cách nhau giữa hai lần đăng vào cùng
    // nhóm): đây là quyết định KHÔNG đăng, phải hiện ở mức INFO như mọi nhánh skipped khác.
    if (carryover === "deferred" || today === "deferred") {
        return { action: "skipped", reason: "Mọi bài đến hạn đều đang phải hoãn (cách nhau giữa hai lần đăng vào cùng nhóm, hoặc hạn mức nhóm)" };
    }

    return { action: "idle", reason: "Không có job nào đến hạn" };
}

/** Số job đăng bài đang chờ — dùng cho health check và lệnh /status. */
export async function countPendingPostJobs(): Promise<number> {
    return postJobs().countDocuments({ type: "post_to_group", status: "pending" });
}
