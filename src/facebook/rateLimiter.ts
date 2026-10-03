import { env } from "../config/env.js";
import { APP_STATE_ID } from "../config/constants.js";
import { appState, groups } from "../db/collections.js";
import type { GroupDoc } from "../models/group.model.js";
import { randomInt } from "../utils/delay.js";
import { childLogger } from "../utils/logger.js";
import { firstWindowStartOn, formatActiveWindows, isWithinWindows, nextWindowStart } from "../utils/activeWindows.js";
import { businessDateKey, businessHour } from "../utils/time.js";
import { slotFor, type PostKind, type QuotaLimits, type QuotaUsage } from "./dailyQuota.js";

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
 * Số bài đã đăng trong ngày hôm nay, tự động lật bộ đếm sang ngày mới nếu cần.
 *
 * Bộ đếm ngày phải reset theo giờ Việt Nam. Nếu so sánh theo ngày UTC, trên VPS bộ đếm sẽ
 * nhảy sang ngày mới lúc 7h sáng giờ VN — nghĩa là hạn mức ngày bị cấp lại giữa buổi sáng,
 * đúng lúc đang đăng nhiều nhất.
 *
 * PHẢI export và PHẢI là đường duy nhất để đọc `total_posts_today`. Đọc thẳng
 * `app_state.daily_counters.total_posts_today` là đọc một con số có thể của ngày hôm kia:
 * việc lật ngày chỉ xảy ra bên trong hàm này, nên bất kỳ chốt chặn nào đọc số thô rồi
 * dừng sớm sẽ tự khoá chính nó lại vĩnh viễn — chốt chặn đó chặn luôn đường duy nhất
 * reset được con số đang chặn nó. Đó đúng là lỗi đã làm hệ thống ngừng đăng từ 4/9/2026:
 * `runCycle` đọc số thô 10/10 của ngày 4/9 và trả về "đã đủ bài hôm nay" mọi nhịp,
 * nên `checkPostingAllowed` — nơi chứa hàm reset — không bao giờ được gọi tới nữa.
 */
export async function postsTodayCount(): Promise<number> {
    const today = businessDateKey();
    const state = await appState().findOne({ _id: APP_STATE_ID });

    if (state?.daily_counters.date === today) {
        return state.daily_counters.total_posts_today;
    }

    await appState().updateOne(
        { _id: APP_STATE_ID },
        {
            $set: {
                daily_counters: { date: today, total_posts_today: 0, carryover_posts_today: 0 },
                updated_at: new Date(),
            },
        },
    );
    await groups().updateMany({ posts_today_count: { $gt: 0 } }, { $set: { posts_today_count: 0 } });

    log.info({ date: today }, "Đã reset bộ đếm ngày mới");
    return 0;
}

/**
 * Suất đã dùng hôm nay, cả suất thường lẫn suất bù cho bài tồn.
 *
 * Đi qua `postsTodayCount()` TRƯỚC để bộ đếm được lật sang ngày mới — cùng lý do mà mọi chỗ đọc
 * bộ đếm phải đi qua hàm đó (xem chú thích của nó). Đọc lại document sau đó là đọc bản đã lật.
 */
export async function dailyQuotaUsed(): Promise<QuotaUsage> {
    const regular = await postsTodayCount();
    const state = await appState().findOne({ _id: APP_STATE_ID });
    return { regular, carryover: state?.daily_counters.carryover_posts_today ?? 0 };
}

export function dailyQuotaLimits(): QuotaLimits {
    return { regular: env.MAX_POSTS_PER_DAY, carryoverExtra: env.CARRYOVER_EXTRA_POSTS_PER_DAY };
}

function withJitter(date: Date): Date {
    return new Date(date.getTime() + randomInt(0, env.ACTIVE_HOURS_JITTER_MINUTES) * 60_000);
}

/**
 * Đầu khung giờ đăng kế tiếp (có thể ngay trong hôm nay), cộng nhiễu ngẫu nhiên.
 *
 * Nhiễu quan trọng: nếu ngày nào bài đầu tiên cũng lên đúng phút mở khung, đó chính là dấu hiệu
 * lịch chạy máy móc mà khung giờ hoạt động sinh ra để tránh.
 */
function nextActiveWindowStart(): Date {
    return withJitter(nextWindowStart(new Date(), env.ACTIVE_WINDOWS));
}

/**
 * Đầu khung đầu tiên của NGÀY MAI — dùng khi đã hết hạn mức hôm nay. Không dùng
 * `nextActiveWindowStart` ở đây: đang nghỉ trưa thì khung kế tiếp là 18h cùng ngày, mà hạn mức
 * ngày thì tới 18h vẫn còn hết.
 */
function tomorrowWindowStart(): Date {
    const tomorrow = businessDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000));
    return withJitter(firstWindowStartOn(tomorrow, env.ACTIVE_WINDOWS));
}

/**
 * Thời điểm đã cho có nằm trong khung giờ được phép đăng hay không (theo giờ VN).
 *
 * Mặc định đọc `ACTIVE_WINDOWS`. Truyền giờ bắt đầu/kết thúc thì kiểm một khung liền duy nhất —
 * để kiểm thử được ranh giới mà không phụ thuộc vào .env lẫn thời điểm chạy test.
 */
export function isWithinActiveHours(date: Date = new Date(), startHour?: number, endHour?: number): boolean {
    if (startHour !== undefined && endHour !== undefined) {
        const hour = businessHour(date);
        return hour >= startHour && hour < endHour;
    }
    return isWithinWindows(date, env.ACTIVE_WINDOWS);
}

/**
 * Kiểm tra toàn bộ điều kiện trước khi cho phép đăng một bài.
 *
 * Thứ tự kiểm tra đi từ chặn cứng đến chặn mềm: cầu dao đã ngắt thì không cần
 * quan tâm tới hạn mức nữa.
 */
export async function checkPostingAllowed(group: GroupDoc, kind: PostKind = "regular"): Promise<GateResult> {
    const state = await appState().findOne({ _id: APP_STATE_ID });

    if (state?.circuit_breaker.tripped) {
        // Không đặt retryAt: cầu dao chỉ mở lại khi người dùng chủ động xác nhận.
        return blocked(`Cầu dao Facebook đang ngắt: ${state.circuit_breaker.reason ?? "không rõ lý do"}`);
    }

    if (!isWithinActiveHours()) {
        const retryAt = nextActiveWindowStart();
        return blocked(
            `Ngoài khung giờ đăng bài (${formatActiveWindows(env.ACTIVE_WINDOWS)} giờ VN)`,
            retryAt,
        );
    }

    // Bài tồn còn suất bù thì qua được cả khi suất thường đã hết — xem dailyQuota.ts.
    if (slotFor(kind, await dailyQuotaUsed(), dailyQuotaLimits()) === null) {
        return blocked(
            kind === "carryover"
                ? `Đã dùng hết ${env.MAX_POSTS_PER_DAY} suất thường và ${env.CARRYOVER_EXTRA_POSTS_PER_DAY} suất bù hôm nay`
                : `Đã đạt hạn mức ${env.MAX_POSTS_PER_DAY} bài/ngày`,
            tomorrowWindowStart(),
        );
    }

    if (group.posts_today_count >= group.post_frequency.max_posts_per_day) {
        return blocked(
            `Group "${group.name}" đã đạt hạn mức ${group.post_frequency.max_posts_per_day} bài/ngày`,
            tomorrowWindowStart(),
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

/**
 * Ghi nhận một bài đã đăng thành công vào các bộ đếm.
 *
 * Bài tồn cộng vào bộ đếm bù khi còn suất bù, hết thì cộng vào suất thường — đúng thứ tự mà
 * `checkPostingAllowed` đã cho qua. Hạn mức RIÊNG của nhóm thì bài nào cũng tính như nhau: miễn
 * hạn mức ngày là để không bỏ sót phòng, không phải để dồn thêm bài vào một nhóm.
 */
export async function recordSuccessfulPost(group: GroupDoc, kind: PostKind = "regular"): Promise<void> {
    const now = new Date();
    const slot = slotFor(kind, await dailyQuotaUsed(), dailyQuotaLimits()) ?? "regular";
    const counter = slot === "carryover" ? "daily_counters.carryover_posts_today" : "daily_counters.total_posts_today";

    await groups().updateOne(
        { _id: group._id },
        { $set: { last_posted_at: now, updated_at: now }, $inc: { posts_today_count: 1 } },
    );

    await appState().updateOne(
        { _id: APP_STATE_ID },
        { $inc: { [counter]: 1 }, $set: { updated_at: now } },
    );
}
