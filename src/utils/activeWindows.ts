import { businessDateKey } from "./time.js";

/**
 * Một khung giờ đăng trong ngày, tính bằng phút kể từ 0h giờ VN. `endMinute` không nằm trong khung.
 *
 * Tồn tại vì "giờ đẹp" để đăng tin phòng trọ không phải một dải liền: người đi làm lướt nhóm lúc
 * sáng sớm, giờ nghỉ trưa và buổi tối — còn 14h-17h gần như không ai đọc. Một cặp START/END duy
 * nhất buộc phải chọn giữa bỏ phí giờ tối hoặc đăng cả vào giờ chết.
 */
export interface TimeWindow {
    startMinute: number;
    endMinute: number;
}

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;

function parseClock(raw: string): number {
    const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(raw.trim());
    if (!match) throw new Error(`Giờ "${raw}" sai định dạng, cần HH:MM`);

    const hours = Number(match[1]);
    const minutes = Number(match[2] ?? 0);
    const total = hours * 60 + minutes;

    if (minutes > 59 || total > MINUTES_PER_DAY) throw new Error(`Giờ "${raw}" nằm ngoài 00:00-24:00`);
    return total;
}

/**
 * `"07:00-09:00,11:00-13:30,18:00-22:30"` -> danh sách khung đã sắp xếp.
 *
 * Khác `csvNumberMap` trong env.ts, ở đây gõ sai là NÉM LỖI chứ không bỏ qua: bỏ qua một khung gõ
 * nhầm thì agent lặng lẽ không đăng vào giờ đó, hoặc tệ hơn là rơi về khung mặc định cả ngày.
 * Khung chồng nhau cũng bị từ chối, vì `addActiveMinutes` sẽ đếm trùng phút.
 */
export function parseActiveWindows(spec: string): TimeWindow[] {
    const windows = spec
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const [start, end, extra] = part.split("-");
            if (start === undefined || end === undefined || extra !== undefined) {
                throw new Error(`Khung giờ "${part}" sai định dạng, cần HH:MM-HH:MM`);
            }
            const window = { startMinute: parseClock(start), endMinute: parseClock(end) };
            if (window.endMinute <= window.startMinute) {
                throw new Error(`Khung giờ "${part}": giờ kết thúc phải sau giờ bắt đầu (không hỗ trợ qua đêm)`);
            }
            return window;
        })
        .sort((a, b) => a.startMinute - b.startMinute);

    for (let index = 1; index < windows.length; index++) {
        if ((windows[index] as TimeWindow).startMinute < (windows[index - 1] as TimeWindow).endMinute) {
            throw new Error("Các khung giờ đăng bị chồng lên nhau");
        }
    }

    return windows;
}

function formatClock(minute: number): string {
    const hours = Math.floor(minute / 60);
    const minutes = minute % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h${String(minutes).padStart(2, "0")}`;
}

/** Nhãn cho log/Telegram: `7h-9h, 11h-13h30, 18h-22h30`. */
export function formatActiveWindows(windows: TimeWindow[]): string {
    return windows.map((w) => `${formatClock(w.startMinute)}-${formatClock(w.endMinute)}`).join(", ");
}

/** 0h giờ VN của một ngày. VN không có giờ mùa hè nên offset +07:00 cố định là đúng. */
function vnMidnight(dateKey: string): Date {
    return new Date(`${dateKey}T00:00:00+07:00`);
}

function atMinute(dateKey: string, minute: number): Date {
    return new Date(vnMidnight(dateKey).getTime() + minute * MS_PER_MINUTE);
}

function nextDateKey(dateKey: string): string {
    // Cộng 36h từ 0h rồi lấy khoá ngày: rơi chắc chắn vào giữa ngày hôm sau.
    return businessDateKey(new Date(vnMidnight(dateKey).getTime() + 36 * 60 * MS_PER_MINUTE));
}

/** Khung chứa thời điểm đã cho, hoặc `null` nếu đang ở giờ nghỉ. */
function windowAt(date: Date, windows: TimeWindow[]): { end: Date } | null {
    const key = businessDateKey(date);
    const minute = (date.getTime() - vnMidnight(key).getTime()) / MS_PER_MINUTE;
    const hit = windows.find((w) => minute >= w.startMinute && minute < w.endMinute);
    return hit ? { end: atMinute(key, hit.endMinute) } : null;
}

export function isWithinWindows(date: Date, windows: TimeWindow[]): boolean {
    return windowAt(date, windows) !== null;
}

/** Đầu khung đầu tiên của một ngày (giờ VN). */
export function firstWindowStartOn(dateKey: string, windows: TimeWindow[]): Date {
    return atMinute(dateKey, (windows[0] as TimeWindow).startMinute);
}

/**
 * Đầu khung KẾ TIẾP bắt đầu sau thời điểm đã cho — có thể ngay trong hôm nay (đang nghỉ trưa thì
 * là 18h cùng ngày), chứ không mặc định nhảy sang sáng mai như khi chỉ có một khung.
 */
export function nextWindowStart(date: Date, windows: TimeWindow[]): Date {
    const key = businessDateKey(date);
    for (const window of windows) {
        const start = atMinute(key, window.startMinute);
        if (start.getTime() > date.getTime()) return start;
    }
    return firstWindowStartOn(nextDateKey(key), windows);
}

/**
 * Cộng `minutes` phút, nhưng CHỈ đếm phút nằm trong khung giờ đăng.
 *
 * Đây là thứ giữ cho giãn cách còn ý nghĩa khi có nhiều khung: cộng thẳng giờ đồng hồ thì các bài
 * rơi vào giờ nghỉ trưa sẽ dồn cục chờ sẵn, đến 18h cùng "quá hạn" một lúc — nhịp đăng khi đó chỉ
 * còn do tick quyết định. Đếm phút hoạt động thì bài vẫn trải đều bên trong từng khung.
 * Bắt đầu từ giờ nghỉ thì mốc đầu tiên là đầu khung kế tiếp cộng số phút, không bao giờ đúng phút mở khung.
 */
export function addActiveMinutes(from: Date, minutes: number, windows: TimeWindow[]): Date {
    let cursor = from;
    let remaining = minutes;

    // Chặn vòng lặp vô hạn nếu cấu hình rỗng lọt qua; 1000 khung là dư cho mọi độ trễ hợp lý.
    for (let guard = 0; guard < 1000; guard++) {
        const current = windowAt(cursor, windows);
        if (!current) {
            cursor = nextWindowStart(cursor, windows);
            continue;
        }

        const available = (current.end.getTime() - cursor.getTime()) / MS_PER_MINUTE;
        if (remaining < available) {
            return new Date(cursor.getTime() + remaining * MS_PER_MINUTE);
        }

        remaining -= available;
        cursor = current.end;
    }

    throw new Error("addActiveMinutes: không tìm được mốc trong khung giờ đăng");
}
