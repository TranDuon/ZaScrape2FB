/**
 * Suất đăng trong ngày: suất THƯỜNG (MAX_POSTS_PER_DAY) và suất BÙ cho bài tồn
 * (CARRYOVER_EXTRA_POSTS_PER_DAY). Toàn bộ là hàm thuần — không đọc DB, không đọc env — để quy tắc
 * chia suất test được trọn vẹn; phần đọc bộ đếm nằm ở `rateLimiter.dailyQuotaUsed()`.
 *
 * "Bài tồn" = job đăng được SOẠN trước 0h hôm nay (giờ VN) mà chưa lên. Tính theo `created_at` của
 * job chứ không theo `scheduled_at`: một bài soạn hôm qua rồi bị hoãn sang hôm nay (vì quy tắc cách
 * nhau giữa hai lần đăng vào cùng nhóm) vẫn là phần việc của hôm qua. Hạn mức soạn bài mỗi ngày
 * (`composerWorker.dailyComposeBudget`) cũng tính theo ngày soạn, nên hai cách đếm khớp nhau: hạn
 * mức đăng của một ngày dành cho đúng những bài soạn trong ngày đó.
 */

export type PostKind = "regular" | "carryover";
export type QuotaSlot = "regular" | "carryover";

export interface QuotaUsage {
    /** Bài đã đăng hôm nay, tính vào MAX_POSTS_PER_DAY. */
    regular: number;
    /** Bài tồn đã đăng hôm nay bằng suất bù. */
    carryover: number;
}

export interface QuotaLimits {
    regular: number;
    carryoverExtra: number;
}

export function isCarryoverJob(createdAt: Date, dayStart: Date): boolean {
    return createdAt.getTime() < dayStart.getTime();
}

/**
 * Một bài loại `kind` sẽ tiêu suất nào, hoặc `null` nếu hết cả suất được dùng.
 *
 * Bài tồn dùng suất bù trước; hết suất bù thì RƠI xuống suất thường chứ không bị chặn — bài tồn
 * vẫn được ưu tiên, chỉ không còn được miễn hạn mức. Bài thường chỉ có suất thường.
 */
export function slotFor(kind: PostKind, used: QuotaUsage, limits: QuotaLimits): QuotaSlot | null {
    if (kind === "carryover" && used.carryover < limits.carryoverExtra) return "carryover";
    if (used.regular < limits.regular) return "regular";
    return null;
}
