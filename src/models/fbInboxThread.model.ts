import type { InboxFolder } from "../facebook/inboxParser.js";

/**
 * Một hội thoại Messenger của tài khoản đăng bài, như lần kiểm tra hộp thư gần nhất nhìn thấy.
 * Chỉ để so sánh giữa hai lần kiểm tra (có tin mới không) — không lưu nội dung tin nhắn.
 */
export interface FbInboxThreadDoc {
    /** Mã hội thoại lấy từ link `/messages/.../t/<id>/`. */
    _id: string;
    name: string;
    folder: InboxFolder;
    href: string;
    preview: string;
    /** Ước lượng mốc tin cuối từ nhãn "x phút" — xem `estimateLastActivity`. */
    last_activity_at: Date | null;
    first_seen_at: Date;
    last_seen_at: Date;
    last_notified_at: Date | null;
}
