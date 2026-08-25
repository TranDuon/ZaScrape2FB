import { env } from "../config/env.js";
import { APP_STATE_ID } from "../config/constants.js";
import { appState, groups } from "../db/collections.js";
import type { GroupDoc } from "../models/group.model.js";
import { randomInt } from "../utils/delay.js";
import { childLogger } from "../utils/logger.js";
import { businessDateKey, businessHour } from "../utils/time.js";

const log = childLogger("fb:ratelimit");

export interface GateResult {
    allowed: boolean;
    reason: string;
    /** Có giá trị khi nên hoãn job thay vì huỷ — ví dụ ngoài khung giờ hoạt động. */
    retryAt: Date | null;
}

const ALLOWED: GateResult = { allowed: true, reason: "Đủ điều kiện đăng", retryAt: null };

function blocked(reason: string, retryAt: Date | null = null): GateResult {
    return { allowed: false, reason, retryAt };
}

/**
 * Bộ đếm ngày phải reset theo giờ Việt Nam.
 *
 * Nếu so sánh theo ngày UTC, trên VPS bộ đếm sẽ nhảy sang ngày mới lúc 7h sáng giờ VN —
 * nghĩa là hạn mức ngày bị cấp lại giữa buổi sáng, đúng lúc đang đăng nhiều nhất.
 */
async function resetDailyCountersIfNeeded(): Promise<number> {
    const today = businessDateKey();
    const state = await appState().findOne({ _id: APP_STATE_ID });

    if (state?.daily_counters.date === today) {
        return state.daily_counters.total_posts_today;
    }

    await appState().updateOne(
        { _id: APP_STATE_ID },
        { $set: { daily_counters: { date: today, total_posts_today: 0 }, updated_at: new Date() } },
    );
    await groups().updateMany({ posts_today_count: { $gt: 0 } }, { $set: { posts_today_count: 0 } });

    log.info({ date: today }, "Đã reset bộ đếm ngày mới");
    return 0;
}

/**
 * Mốc bắt đầu khung giờ hoạt động của ngày hôm sau, cộng nhiễu ngẫu nhiên.
 *
 * Nhiễu quan trọng: nếu ngày nào bài đầu tiên cũng lên đúng 8h00, đó chính là dấu hiệu
 * lịch chạy máy móc mà khung giờ hoạt động sinh ra để tránh.
 */
function nextActiveWindowStart(): Date {
    const now = new Date();
    const target = new Date(now);
    const currentHour = businessHour(now);

    if (currentHour >= env.ACTIVE_HOURS_END) {
        target.setDate(target.getDate() + 1);
    }

    // Đặt giờ theo giờ VN rồi bù lệch múi giờ về giờ hệ thống, vì máy chủ có thể chạy UTC.
    const offsetMinutes = getTimezoneOffsetMinutes(target);
    target.setHours(env.ACTIVE_HOURS_START, 0, 0, 0);
    target.setMinutes(target.getMinutes() - offsetMinutes + randomInt(0, env.ACTIVE_HOURS_JITTER_MINUTES));

    return target;
}

/** Chênh lệch (phút) giữa giờ Việt Nam và giờ hệ thống tại thời điểm đã cho. */
function getTimezoneOffsetMinutes(date: Date): number {
    const localHour = date.getHours();
    const vietnamHour = businessHour(date);
    return (vietnamHour - localHour) * 60;
}

/**
 * Thời điểm đã cho có nằm trong khung giờ được phép đăng hay không (theo giờ VN).
 *
 * Cho phép truyền giờ bắt đầu/kết thúc để kiểm thử được ranh giới mà không phụ thuộc
 * vào .env lẫn thời điểm chạy test.
 */
export function isWithinActiveHours(
    date: Date = new Date(),
    startHour: number = env.ACTIVE_HOURS_START,
    endHour: number = env.ACTIVE_HOURS_END,
): boolean {
    const hour = businessHour(date);
    return hour >= startHour && hour < endHour;
}

/**
 * Kiểm tra toàn bộ điều kiện trước khi cho phép đăng một bài.
 *
 * Thứ tự kiểm tra đi từ chặn cứng đến chặn mềm: cầu dao đã ngắt thì không cần
 * quan tâm tới hạn mức nữa.
 */
export async function checkPostingAllowed(group: GroupDoc): Promise<GateResult> {
    const state = await appState().findOne({ _id: APP_STATE_ID });

    if (state?.circuit_breaker.tripped) {
        // Không đặt retryAt: cầu dao chỉ mở lại khi người dùng chủ động xác nhận.
        return blocked(`Cầu dao Facebook đang ngắt: ${state.circuit_breaker.reason ?? "không rõ lý do"}`);
    }

    if (!isWithinActiveHours()) {
        const retryAt = nextActiveWindowStart();
        return blocked(
            `Ngoài khung giờ đăng bài (${env.ACTIVE_HOURS_START}h-${env.ACTIVE_HOURS_END}h giờ VN)`,
            retryAt,
        );
    }

    const postsToday = await resetDailyCountersIfNeeded();
    if (postsToday >= env.MAX_POSTS_PER_DAY) {
        return blocked(`Đã đạt hạn mức ${env.MAX_POSTS_PER_DAY} bài/ngày`, nextActiveWindowStart());
    }

    if (group.posts_today_count >= group.post_frequency.max_posts_per_day) {
        return blocked(
            `Group "${group.name}" đã đạt hạn mức ${group.post_frequency.max_posts_per_day} bài/ngày`,
            nextActiveWindowStart(),
        );
    }

    if (group.last_posted_at) {
        const minutesSince = (Date.now() - group.last_posted_at.getTime()) / 60_000;
        const required = group.post_frequency.min_interval_minutes;

        if (minutesSince < required) {
            const waitMinutes = Math.ceil(required - minutesSince);
            return blocked(
                `Mới đăng vào group này ${Math.floor(minutesSince)} phút trước, cần cách ít nhất ${required} phút`,
                new Date(Date.now() + waitMinutes * 60_000),
            );
        }
    }

    return ALLOWED;
}

/** Ghi nhận một bài đã đăng thành công vào các bộ đếm. */
export async function recordSuccessfulPost(group: GroupDoc): Promise<void> {
    const now = new Date();

    await groups().updateOne(
        { _id: group._id },
        { $set: { last_posted_at: now, updated_at: now }, $inc: { posts_today_count: 1 } },
    );

    await appState().updateOne(
        { _id: APP_STATE_ID },
        { $inc: { "daily_counters.total_posts_today": 1 }, $set: { updated_at: now } },
    );
}
