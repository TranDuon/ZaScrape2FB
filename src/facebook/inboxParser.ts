/**
 * Phần THUẦN của việc đọc hộp thư Messenger: tách một dòng hội thoại thành dữ liệu, và quyết định
 * dòng đó có tin mới hay không. Không đụng Playwright hay MongoDB để test được bằng chuỗi thật.
 *
 * Dữ liệu mẫu đo trên tài khoản đăng bài ngày 2026-10-04 — `innerText` của mỗi thẻ
 * `a[href*="/t/"]` trong danh sách đoạn chat:
 *
 *   "Min Min\nKhông khôi phục được tin nhắn\n \n·\n10 giờ"
 *   "Đang hoạt động\nMinh Thanh\nKhông khôi phục được tin nhắn\n \n·\n1 tuần"
 *   "Vua Nệm\nTin nhắn chưa đọc: Vua Nệm đã gửi một file đính kèm.\n \n·\n1 tuần"
 */

export type InboxFolder = "inbox" | "requests";

export interface InboxRow {
    threadId: string;
    href: string;
    name: string;
    /** Nội dung xem trước đã chuẩn hoá; tin mã hoá đầu cuối gom về `E2EE_PREVIEW`. */
    preview: string;
    /** Facebook gắn "Tin nhắn chưa đọc:" trước nội dung. Tin mã hoá thì KHÔNG có dấu này. */
    unread: boolean;
    /** Tin cuối là của chính tài khoản này ("Bạn: ...") — tức là đã trả lời rồi. */
    fromSelf: boolean;
    /** Tuổi tin cuối tính bằng phút, suy từ nhãn "10 giờ"/"5 phút". null = không đọc được nhãn. */
    ageMinutes: number | null;
    folder: InboxFolder;
}

/**
 * Tin nhắn mã hoá đầu cuối không giải mã được trong trình duyệt của agent (cần mã PIN khôi phục),
 * nên Facebook chỉ hiện một câu giữ chỗ. Gom mọi câu giữ chỗ về một giá trị: đổi qua lại giữa chúng
 * KHÔNG có nghĩa là có tin mới, và tin mới thật được nhận ra qua mốc thời gian thay vì nội dung.
 */
export const E2EE_PREVIEW = "[mã hoá]";

const E2EE_PLACEHOLDERS = [
    /không khôi phục được tin nhắn/i,
    /được bảo mật bằng tính năng mã hóa đầu cuối/i,
    /mã hóa đầu cuối/i,
    /couldn't restore|end-to-end encrypted/i,
];

const ACTIVE_STATUS = /^(đang hoạt động|active now)$/i;
const UNREAD_PREFIX = /^(tin nhắn chưa đọc|unread message):\s*/i;
const SELF_PREFIX = /^(bạn|you):\s*/i;

const AGE_UNITS: Array<[RegExp, number]> = [
    [/^(\d+)\s*(phút|p|m|min|mins|minutes?)$/i, 1],
    [/^(\d+)\s*(giờ|h|hr|hrs|hours?)$/i, 60],
    [/^(\d+)\s*(ngày|d|days?)$/i, 60 * 24],
    [/^(\d+)\s*(tuần|w|wk|weeks?)$/i, 60 * 24 * 7],
    [/^(\d+)\s*(năm|y|yr|years?)$/i, 60 * 24 * 365],
];

/** "10 giờ" → 600, "Vừa xong" → 0, chữ lạ → null. */
export function parseRelativeAge(label: string): number | null {
    const text = label.trim();
    if (/^(vừa xong|just now|bây giờ|now)$/i.test(text)) return 0;

    for (const [pattern, minutes] of AGE_UNITS) {
        const match = pattern.exec(text);
        if (match) return Number(match[1]) * minutes;
    }
    return null;
}

/** Mã hội thoại trong link: `/messages/e2ee/requests/t/1655840529576595/` → `1655840529576595`. */
export function threadIdFromHref(href: string): string | null {
    return /\/t\/(\d+)/.exec(href)?.[1] ?? null;
}

export function parseInboxRow(raw: string, href: string, folder: InboxFolder): InboxRow | null {
    const threadId = threadIdFromHref(href);
    if (!threadId) return null;

    const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line !== "·" && !ACTIVE_STATUS.test(line));

    const name = lines[0];
    if (!name) return null;

    // Nhãn thời gian là dòng cuối, nhưng hội thoại chưa có tin nào thì có thể không có nhãn.
    const last = lines.length > 1 ? lines[lines.length - 1]! : "";
    const ageMinutes = parseRelativeAge(last);
    const previewLines = lines.slice(1, ageMinutes === null ? lines.length : -1);

    let preview = previewLines.join(" ").replace(/\s+/g, " ").trim();
    const unread = UNREAD_PREFIX.test(preview);
    preview = preview.replace(UNREAD_PREFIX, "");
    const fromSelf = SELF_PREFIX.test(preview);

    if (E2EE_PLACEHOLDERS.some((pattern) => pattern.test(preview))) preview = E2EE_PREVIEW;

    return { threadId, href, name, preview, unread, fromSelf, ageMinutes, folder };
}

/** Những gì đã lưu về một hội thoại ở lần kiểm tra trước. */
export interface KnownThread {
    preview: string;
    /** Ước lượng thời điểm tin cuối. Chỉ cập nhật từ nhãn tính bằng phút — nhãn giờ/ngày quá thô. */
    last_activity_at: Date | null;
}

/**
 * Nhãn dưới 60 phút chính xác tới phút; từ "1 giờ" trở lên thì sai số cả tiếng, so vào sẽ báo nhầm
 * (nhãn "10 giờ" lúc 11h00 và lúc 11h59 cho ra hai mốc lệch nhau gần một tiếng).
 */
const PRECISE_AGE_LIMIT_MINUTES = 60;
/** Nhãn "5 phút" có thể là 5 phút 59 giây — chừa biên để không báo lại cùng một tin. */
const ACTIVITY_TOLERANCE_MS = 5 * 60_000;

export type ActivityVerdict = "new_thread" | "new_message" | "none";

/**
 * Có tin mới ở hội thoại này kể từ lần kiểm tra trước không.
 *
 * Không dựa được vào nội dung: tin mã hoá đầu cuối luôn hiện cùng một câu giữ chỗ. Nên tin mới
 * được nhận ra theo HAI đường độc lập — nội dung xem trước đổi, hoặc mốc tin cuối (suy từ nhãn
 * "x phút") nhích lên. Lịch kiểm tra 15 phút một lần nên tin mới luôn được thấy khi nhãn còn ở
 * dạng phút, vùng duy nhất đủ chính xác để so.
 */
export function detectActivity(row: InboxRow, known: KnownThread | null, now: Date): ActivityVerdict {
    // Tin cuối là của mình = đã trả lời, không có gì phải báo.
    if (row.fromSelf) return "none";
    if (!known) return "new_thread";
    if (row.preview !== known.preview) return "new_message";

    const estimate = estimateLastActivity(row, now);
    if (estimate === null) return "none";
    if (known.last_activity_at === null) return "new_message";

    return estimate.getTime() > known.last_activity_at.getTime() + ACTIVITY_TOLERANCE_MS ? "new_message" : "none";
}

/** Mốc tin cuối suy từ nhãn — chỉ khi nhãn tính bằng phút, ngoài ra null. */
export function estimateLastActivity(row: InboxRow, now: Date): Date | null {
    if (row.ageMinutes === null || row.ageMinutes >= PRECISE_AGE_LIMIT_MINUTES) return null;
    return new Date(now.getTime() - row.ageMinutes * 60_000);
}

/** "0" → "vừa xong", 600 → "10 giờ trước" — để thông báo đọc tự nhiên. */
export function formatAge(ageMinutes: number | null): string {
    if (ageMinutes === null) return "không rõ lúc nào";
    if (ageMinutes === 0) return "vừa xong";
    if (ageMinutes < 60) return `${ageMinutes} phút trước`;
    if (ageMinutes < 60 * 24) return `${Math.round(ageMinutes / 60)} giờ trước`;
    if (ageMinutes < 60 * 24 * 7) return `${Math.round(ageMinutes / (60 * 24))} ngày trước`;
    return `${Math.round(ageMinutes / (60 * 24 * 7))} tuần trước`;
}
