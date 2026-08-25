import { BUSINESS_TIMEZONE } from "../config/constants.js";

/**
 * Khoá ngày dạng `YYYY-MM-DD` theo giờ Việt Nam.
 *
 * KHÔNG dùng `toISOString().slice(0, 10)` — hàm đó trả về ngày theo UTC, nên trên VPS
 * chạy UTC thì bộ đếm ngày sẽ nhảy sang ngày mới lúc 7h sáng giờ VN và `/stats` báo sai ngày.
 */
export function businessDateKey(date: Date = new Date()): string {
    // "sv-SE" cho ra định dạng ISO-like `YYYY-MM-DD HH:mm:ss`, cắt lấy phần ngày.
    return date.toLocaleString("sv-SE", { timeZone: BUSINESS_TIMEZONE }).slice(0, 10);
}

/** Giờ trong ngày (0-23) theo giờ Việt Nam — dùng cho khung giờ hoạt động ở Module Scheduler. */
export function businessHour(date: Date = new Date()): number {
    return Number(date.toLocaleString("en-US", { timeZone: BUSINESS_TIMEZONE, hour12: false, hour: "2-digit" }));
}

/** Nhãn thời gian đầy đủ theo giờ VN, dùng trong thông báo gửi cho người dùng. */
export function formatBusinessTime(date: Date = new Date()): string {
    return date.toLocaleString("vi-VN", { timeZone: BUSINESS_TIMEZONE });
}
