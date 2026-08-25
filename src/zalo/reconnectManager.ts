import type { API } from "zca-js";
import { env } from "../config/env.js";
import { APP_STATE_ID } from "../config/constants.js";
import { appState } from "../db/collections.js";
import { backoffDelay, sleep } from "../utils/delay.js";
import { childLogger } from "../utils/logger.js";
import { formatBusinessTime } from "../utils/time.js";
import { loginWithSavedSession } from "./zaloClient.js";
import type { MessageListener } from "./messageListener.js";

const log = childLogger("zalo:reconnect");

const BASE_BACKOFF_MS = 1_000;
/** Khoảng lặng đủ dài sau khi kết nối lại thì coi như có thể đã bỏ lỡ tin nhắn. */
const MESSAGE_GAP_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Mã đóng kết nối của zca-js (CloseReason).
 * 3000/3003 là phiên bị chiếm hoặc bị đá — kết nối lại chỉ làm tình hình tệ hơn,
 * phải dừng hẳn và báo người dùng.
 */
const CLOSE_REASON = {
    ManualClosure: 1000,
    AbnormalClosure: 1006,
    DuplicateConnection: 3000,
    KickConnection: 3003,
} as const;

const FATAL_CLOSE_CODES: number[] = [CLOSE_REASON.DuplicateConnection, CLOSE_REASON.KickConnection];

export type NotifyFn = (message: string) => Promise<void> | void;

/**
 * Giữ cho listener Zalo sống sót qua các lần rớt mạng.
 *
 * zca-js có retry nội bộ, nhưng nó không biết gì về trạng thái nghiệp vụ: khi phiên
 * thật sự hỏng (bị đá, cookie hết hạn) thì việc thử lại vô hạn chỉ tạo thêm tín hiệu
 * bất thường cho Zalo. Lớp này quyết định khi nào nên thử lại và khi nào phải dừng
 * để người dùng đăng nhập lại bằng tay.
 */
export class ReconnectManager {
    private api: API | null = null;
    private attempts = 0;
    private stopped = false;
    private reconnecting = false;

    constructor(
        private readonly listener: MessageListener,
        private readonly notify: NotifyFn,
    ) {}

    async start(): Promise<void> {
        this.stopped = false;
        await this.connect();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.api?.listener.stop();
        this.api = null;
        await this.setSessionState({ connected: false });
        log.info("Đã dừng listener Zalo");
    }

    private async connect(): Promise<void> {
        this.api = await loginWithSavedSession();
        this.listener.attach(this.api);
        this.bindLifecycle(this.api);
        await this.logWatchedThreads(this.api);

        // retryOnClose: false — tự điều phối việc kết nối lại ở đây để còn phân biệt
        // được lỗi tạm thời với lỗi phiên hỏng hẳn.
        this.api.listener.start({ retryOnClose: false });
    }

    /**
     * In ra tên các nhóm đang được lọc. Đối chiếu ID với tên ngay lúc khởi động
     * rẻ hơn nhiều so với việc ngồi chờ tin nhắn rồi mới phát hiện lọc sai nhóm.
     */
    private async logWatchedThreads(api: API): Promise<void> {
        const threadIds = env.ZALO_ALLOWED_THREAD_IDS;

        if (threadIds.length === 0) {
            log.warn("Không lọc nhóm — agent sẽ xử lý mọi cuộc trò chuyện. Nên đặt ZALO_ALLOWED_THREAD_IDS.");
            return;
        }

        try {
            const info = await api.getGroupInfo(threadIds);
            for (const threadId of threadIds) {
                const name = info.gridInfoMap[threadId]?.name;
                if (name) {
                    log.info({ thread_id: threadId }, `Đang theo dõi nhóm: ${name}`);
                } else {
                    // Thường là do ID sai hoặc tài khoản đã rời nhóm.
                    log.warn({ thread_id: threadId }, "Không đọc được thông tin nhóm — kiểm tra lại ID");
                }
            }
        } catch (error) {
            log.warn({ err: error }, "Không lấy được tên nhóm (không ảnh hưởng việc nhận tin)");
        }
    }

    private bindLifecycle(api: API): void {
        api.listener.on("connected", () => {
            void this.handleConnected();
        });

        api.listener.on("closed", (code, reason) => {
            void this.handleClosed(code, reason);
        });

        api.listener.on("error", (error) => {
            log.error({ err: error }, "Listener Zalo báo lỗi");
        });
    }

    private async handleConnected(): Promise<void> {
        const previous = await appState().findOne({ _id: APP_STATE_ID });
        const lastMessageAt = previous?.zalo_session.last_message_at ?? null;

        this.attempts = 0;
        await this.setSessionState({ connected: true, connectedAt: new Date(), error: null });
        await appState().updateOne(
            { _id: APP_STATE_ID },
            {
                $set: {
                    "zalo_circuit_breaker.tripped": false,
                    "zalo_circuit_breaker.reason": null,
                    "zalo_circuit_breaker.reconnect_attempts": 0,
                    updated_at: new Date(),
                },
            },
        );

        log.info("Listener Zalo đã kết nối");
        await this.warnAboutMessageGap(lastMessageAt);
    }

    /**
     * Không thể lấy lại tin nhắn đã lỡ một cách chắc chắn, nên việc đúng đắn duy nhất
     * là nói rõ khoảng thời gian nghi ngờ để người dùng tự mở Zalo kiểm tra.
     */
    private async warnAboutMessageGap(lastMessageAt: Date | null): Promise<void> {
        if (!lastMessageAt) return;

        const gapMs = Date.now() - lastMessageAt.getTime();
        if (gapMs < MESSAGE_GAP_THRESHOLD_MS) return;

        const minutes = Math.round(gapMs / 60_000);
        await this.notify(
            `Zalo đã kết nối lại sau khoảng lặng ${minutes} phút ` +
                `(từ ${formatBusinessTime(lastMessageAt)} đến ${formatBusinessTime(new Date())}). ` +
                `Có thể có tin nhắn bị bỏ lỡ — nên mở Zalo kiểm tra lại khoảng thời gian này.`,
        );
    }

    private async handleClosed(code: number, reason: string): Promise<void> {
        if (this.stopped || code === CLOSE_REASON.ManualClosure) return;

        await this.setSessionState({ connected: false, disconnectedAt: new Date(), error: reason });

        if (FATAL_CLOSE_CODES.includes(code)) {
            await this.trip(
                code === CLOSE_REASON.DuplicateConnection
                    ? "Phiên Zalo bị chiếm bởi một kết nối khác (mở Zalo Web ở nơi khác sẽ ngắt bot)"
                    : "Phiên Zalo bị đá khỏi thiết bị",
            );
            return;
        }

        await this.scheduleReconnect(reason);
    }

    private async scheduleReconnect(reason: string): Promise<void> {
        if (this.reconnecting) return;
        this.reconnecting = true;

        try {
            while (!this.stopped && this.attempts < env.ZALO_RECONNECT_MAX_ATTEMPTS) {
                this.attempts += 1;
                const delay = backoffDelay(this.attempts, BASE_BACKOFF_MS, env.ZALO_RECONNECT_MAX_BACKOFF_MS);

                log.warn(
                    { attempt: this.attempts, max: env.ZALO_RECONNECT_MAX_ATTEMPTS, delay_ms: delay, reason },
                    "Mất kết nối Zalo, sẽ thử lại",
                );
                await appState().updateOne(
                    { _id: APP_STATE_ID },
                    { $set: { "zalo_circuit_breaker.reconnect_attempts": this.attempts, updated_at: new Date() } },
                );

                await sleep(delay);
                if (this.stopped) return;

                try {
                    await this.connect();
                    return;
                } catch (error) {
                    log.error({ err: error, attempt: this.attempts }, "Kết nối lại Zalo thất bại");
                }
            }

            if (!this.stopped) {
                await this.trip(`Kết nối lại thất bại ${this.attempts} lần liên tiếp. Phiên Zalo có thể đã hết hạn.`);
            }
        } finally {
            this.reconnecting = false;
        }
    }

    /**
     * Ngắt cầu dao Zalo. Chỉ dừng việc NHẬN tin mới — các listing đã nằm trong
     * MongoDB vẫn được trích xuất và đăng bình thường.
     */
    private async trip(reason: string): Promise<void> {
        this.stopped = true;
        this.api?.listener.stop();

        await appState().updateOne(
            { _id: APP_STATE_ID },
            {
                $set: {
                    "zalo_circuit_breaker.tripped": true,
                    "zalo_circuit_breaker.tripped_at": new Date(),
                    "zalo_circuit_breaker.reason": reason,
                    "zalo_session.connected": false,
                    "zalo_session.last_error": reason,
                    updated_at: new Date(),
                },
            },
        );

        log.error({ reason }, "Đã ngắt cầu dao Zalo — cần can thiệp thủ công");
        await this.notify(`Zalo đã dừng nhận tin nhắn: ${reason}\nChạy lại: npm run login:zalo`);
    }

    private async setSessionState(state: {
        connected: boolean;
        connectedAt?: Date;
        disconnectedAt?: Date;
        error?: string | null;
    }): Promise<void> {
        const update: Record<string, unknown> = {
            "zalo_session.connected": state.connected,
            updated_at: new Date(),
        };

        if (state.connectedAt) update["zalo_session.last_connected_at"] = state.connectedAt;
        if (state.disconnectedAt) update["zalo_circuit_breaker.last_disconnect_at"] = state.disconnectedAt;
        if (state.error !== undefined) update["zalo_session.last_error"] = state.error;

        await appState().updateOne({ _id: APP_STATE_ID }, { $set: update });
    }
}
