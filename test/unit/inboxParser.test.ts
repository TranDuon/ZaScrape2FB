import { describe, expect, it } from "vitest";
import {
    E2EE_PREVIEW,
    detectActivity,
    estimateLastActivity,
    parseInboxRow,
    parseRelativeAge,
    type InboxRow,
} from "../../src/facebook/inboxParser.js";

/**
 * Chuỗi `innerText` thật của danh sách đoạn chat, đo trên tài khoản đăng bài ngày 2026-10-04.
 * Lỗi ở đây theo hướng nguy hiểm là IM LẶNG — khách nhắn mà không ai được báo — nên các test
 * "phải báo" quan trọng ngang các test "không được báo nhầm".
 */
const MIN_MIN = "Min Min\nKhông khôi phục được tin nhắn\n \n·\n10 giờ";
const MINH_THANH = "Đang hoạt động\nMinh Thanh\nKhông khôi phục được tin nhắn\n \n·\n1 tuần";
const VUA_NEM = "Vua Nệm\nTin nhắn chưa đọc: Vua Nệm đã gửi một file đính kèm.\n \n·\n1 tuần";
const NOW = new Date("2026-10-04T05:00:00Z");

function row(raw: string, href = "/messages/e2ee/requests/t/1655840529576595/"): InboxRow {
    const parsed = parseInboxRow(raw, href, "requests");
    if (!parsed) throw new Error("không parse được");
    return parsed;
}

describe("parseInboxRow", () => {
    it("tách tên, gom câu giữ chỗ của tin mã hoá, đọc tuổi tin", () => {
        const parsed = row(MIN_MIN);
        expect(parsed).toMatchObject({ threadId: "1655840529576595", name: "Min Min", preview: E2EE_PREVIEW, ageMinutes: 600 });
        expect(parsed.fromSelf).toBe(false);
    });

    it("bỏ dòng trạng thái 'Đang hoạt động' — không lấy nó làm tên", () => {
        expect(row(MINH_THANH).name).toBe("Minh Thanh");
        expect(row(MINH_THANH).ageMinutes).toBe(60 * 24 * 7);
    });

    it("nhận dấu chưa đọc và bỏ tiền tố khỏi nội dung", () => {
        const parsed = row(VUA_NEM, "/messages/requests/t/434513510026090/");
        expect(parsed.unread).toBe(true);
        expect(parsed.preview).toBe("Vua Nệm đã gửi một file đính kèm.");
        expect(parsed.threadId).toBe("434513510026090");
    });

    it("nhận ra tin cuối là của mình", () => {
        expect(row("Lan Anh\nBạn: Phòng còn bạn nhé\n·\n3 phút").fromSelf).toBe(true);
    });

    it("bỏ link không phải hội thoại", () => {
        expect(parseInboxRow("", "/messages/new/", "inbox")).toBeNull();
    });
});

describe("parseRelativeAge", () => {
    it.each([
        ["Vừa xong", 0],
        ["5 phút", 5],
        ["10 giờ", 600],
        ["1 ngày", 1440],
        ["2 tuần", 20160],
        ["3m", 3],
        ["xyz", null],
    ])("%s → %s", (label, expected) => {
        expect(parseRelativeAge(label)).toBe(expected);
    });
});

describe("detectActivity", () => {
    it("hội thoại chưa từng thấy là hội thoại mới", () => {
        expect(detectActivity(row(MIN_MIN), null, NOW)).toBe("new_thread");
    });

    it("PHẢI báo tin mới dù nội dung mã hoá không đổi — nhận ra qua nhãn thời gian", () => {
        // Lần trước thấy "10 giờ" (nhãn thô, không lưu mốc); giờ khách nhắn thêm → nhãn "2 phút".
        const known = { preview: E2EE_PREVIEW, last_activity_at: null };
        const fresh = row("Min Min\nKhông khôi phục được tin nhắn\n·\n2 phút");
        expect(detectActivity(fresh, known, NOW)).toBe("new_message");
    });

    it("PHẢI báo khi mốc tin cuối nhích lên rõ rệt", () => {
        const known = { preview: E2EE_PREVIEW, last_activity_at: new Date(NOW.getTime() - 40 * 60_000) };
        expect(detectActivity(row("Min Min\nKhông khôi phục được tin nhắn\n·\n1 phút"), known, NOW)).toBe("new_message");
    });

    it("không báo lại cùng một tin ở lần kiểm tra sau (nhãn chỉ già đi)", () => {
        // Lần trước thấy "5 phút" lúc NOW-15', tức tin lúc NOW-20'. Giờ nhãn là "20 phút".
        const known = { preview: E2EE_PREVIEW, last_activity_at: new Date(NOW.getTime() - 20 * 60_000) };
        expect(detectActivity(row("Min Min\nKhông khôi phục được tin nhắn\n·\n20 phút"), known, NOW)).toBe("none");
    });

    it("không báo khi nhãn đã sang giờ/ngày và nội dung không đổi", () => {
        const known = { preview: E2EE_PREVIEW, last_activity_at: null };
        expect(detectActivity(row(MIN_MIN), known, NOW)).toBe("none");
    });

    it("báo khi nội dung xem trước đổi", () => {
        const known = { preview: "chào bạn", last_activity_at: null };
        expect(detectActivity(row("Hà\nPhòng còn không ạ\n·\n1 giờ"), known, NOW)).toBe("new_message");
    });

    it("không báo khi tin cuối là của mình (đã trả lời)", () => {
        expect(detectActivity(row("Hà\nBạn: còn bạn ơi\n·\n1 phút"), null, NOW)).toBe("none");
    });

    it("chỉ ước lượng mốc từ nhãn tính bằng phút", () => {
        expect(estimateLastActivity(row(MIN_MIN), NOW)).toBeNull();
        expect(estimateLastActivity(row("A\nx\n·\n5 phút"), NOW)?.getTime()).toBe(NOW.getTime() - 5 * 60_000);
    });
});
