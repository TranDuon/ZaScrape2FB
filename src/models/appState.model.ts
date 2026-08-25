export interface CircuitBreakerState {
    tripped: boolean;
    tripped_at: Date | null;
    reason: string | null;
    /** Luôn true: circuit breaker không bao giờ tự mở lại, phải có người xác nhận. */
    resume_requires_manual_ack: boolean;
}

export interface AppStateDoc {
    _id: string;
    /** Circuit breaker của luồng đăng Facebook. */
    circuit_breaker: CircuitBreakerState;
    /** Circuit breaker riêng của Zalo — sập Zalo không được làm dừng việc đăng bài đang dở. */
    zalo_circuit_breaker: {
        tripped: boolean;
        tripped_at: Date | null;
        reason: string | null;
        last_disconnect_at: Date | null;
        reconnect_attempts: number;
    };
    daily_counters: {
        /** YYYY-MM-DD theo giờ VN (xem utils/time.ts). */
        date: string;
        total_posts_today: number;
    };
    zalo_session: {
        connected: boolean;
        last_connected_at: Date | null;
        /** Mốc tin nhắn cuối nhận được — dùng phát hiện khoảng trống sau khi reconnect. */
        last_message_at: Date | null;
        last_error: string | null;
    };
    fb_session: {
        logged_in: boolean;
        last_checked_at: Date | null;
        last_error: string | null;
    };
    /**
     * Debounce cho cảnh báo đầy đĩa: chỉ báo Telegram một lần mỗi ngày (giờ VN) khi vượt ngưỡng,
     * không báo lại mỗi giờ dù lần kiểm tra nào cũng vượt. Optional vì field này được thêm sau —
     * document cũ trên Atlas chưa có, luôn đọc qua `?? null`.
     */
    disk_warning?: {
        last_notified_date: string | null;
    };
    updated_at: Date;
}
