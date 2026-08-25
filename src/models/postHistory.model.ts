import type { ObjectId } from "mongodb";

/**
 * status là field DUY NHẤT mô tả kết quả (không có field result song song).
 * Giá trị attempting được ghi TRƯỚC khi thao tác đăng bắt đầu: nếu tiến trình chết giữa chừng,
 * bản ghi treo ở attempting là dấu hiệu "có thể đã đăng rồi" — phải báo người dùng
 * kiểm tra thủ công thay vì tự động đăng lại.
 *
 * `unknown` là đích đến của những bản ghi treo đó sau khi `stalePostReaper` đã báo người dùng:
 * agent thành thật là KHÔNG BIẾT bài có lên hay không. Tách riêng khỏi `failed` vì hai thứ này
 * dẫn tới hành động khác hẳn nhau — `failed` là chắc chắn chưa đăng (đăng lại được), `unknown`
 * thì phải mở Facebook nhìn tận mắt trước đã. Chuyển trạng thái cũng đồng thời là cách chống
 * báo trùng: bản ghi hết `attempting` nên vòng quét sau không tìm thấy nữa.
 */
export const POST_HISTORY_STATUS = [
    "attempting",
    "success",
    "failed",
    "checkpoint_blocked",
    "skipped",
    "unknown",
] as const;
export type PostHistoryStatus = (typeof POST_HISTORY_STATUS)[number];

export interface PostHistoryDoc {
    _id?: ObjectId;
    listing_id: ObjectId;
    group_id: ObjectId;
    job_id: ObjectId;
    status: PostHistoryStatus;
    fb_post_url: string | null;
    error_message: string | null;
    screenshot_path: string | null;
    duration_ms: number | null;
    /** Mốc TTL: bản ghi tự xoá sau JOB_HISTORY_RETENTION_DAYS ngày. */
    posted_at: Date;
}
