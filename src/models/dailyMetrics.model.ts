/**
 * Số liệu tổng hợp theo ngày — KHÔNG đặt TTL.
 * Đây là nơi thống kê sống sót sau khi post_jobs/post_history bị TTL 7 ngày dọn đi,
 * nên worker phải cộng dồn ngay khi có sự kiện chứ không tính lại từ lịch sử.
 */
export interface DailyMetricsDoc {
    /** YYYY-MM-DD theo giờ VN. */
    _id: string;
    listings_received: number;
    listings_ignored: number;
    posts_success: number;
    posts_failed: number;
    extraction_time_ms_total: number;
    extraction_count: number;
    /**
     * Số tin ĐÃ SOẠN BÀI trong ngày — chính là thứ chặn ngân sách soạn bài (xem composerWorker).
     * Đếm riêng thay vì suy từ post_jobs, vì post_jobs bị TTL 7 ngày dọn đi còn hạn mức thì phải
     * tính đúng ngay trong ngày.
     */
    compose_count: number;
    posting_time_ms_total: number;
    posting_count: number;
    updated_at: Date;
}
