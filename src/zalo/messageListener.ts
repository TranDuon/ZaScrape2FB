import { MongoServerError, type ObjectId } from "mongodb";
import type { API, Message } from "zca-js";
import { env } from "../config/env.js";
import { APP_STATE_ID } from "../config/constants.js";
import { appState, listings } from "../db/collections.js";
import { incrementDailyMetric } from "../db/indexes.js";
import { enqueueJob } from "../jobs/jobQueue.js";
import { childLogger } from "../utils/logger.js";
import { businessDateKey } from "../utils/time.js";
import type { ListingDoc } from "../models/listing.model.js";
import { downloadImages } from "./mediaDownloader.js";
import { MessageBatcher, type CollectedBatch } from "./messageBatcher.js";
import { parseIncomingMessage } from "./messageParser.js";

const log = childLogger("zalo:listener");

const DUPLICATE_KEY = 11000;

export class MessageListener {
    private readonly batcher: MessageBatcher;

    constructor() {
        this.batcher = new MessageBatcher(env.ZALO_BATCH_WINDOW_MS, env.ZALO_BATCH_MAX_MS, (batch) =>
            this.persistBatch(batch),
        );
    }

    /** Gắn handler vào listener của zca-js. Việc start/stop do reconnectManager điều phối. */
    attach(api: API): void {
        api.listener.on("message", (message) => {
            void this.handleMessage(message).catch((error) => {
                log.error({ err: error }, "Xử lý tin nhắn thất bại");
            });
        });
    }

    async flushPending(): Promise<void> {
        await this.batcher.flushAll();
    }

    get pendingBatches(): number {
        return this.batcher.openCount;
    }

    private async handleMessage(message: Message): Promise<void> {
        // Bỏ qua tin do chính tài khoản này gửi, nếu không bot sẽ tự xử lý tin của mình.
        if (message.isSelf) return;

        const threadId = message.threadId;
        const senderId = message.data.uidFrom;

        if (!this.isAllowed(threadId, senderId)) return;

        const source = {
            threadId,
            threadType: message.type as number,
            senderId,
            senderName: message.data.dName || senderId,
        };

        const messageId = message.data.msgId;
        const timestamp = new Date(parseInt(message.data.ts, 10));
        const parsed = parseIncomingMessage(message);

        switch (parsed.kind) {
            case "text":
                this.batcher.addText(source, messageId, parsed.text, timestamp);
                break;
            case "image":
                this.batcher.addImage(source, messageId, {
                    url: parsed.url,
                    thumb: parsed.thumb,
                    messageId,
                }, timestamp);
                break;
            case "other":
                // Mức WARN chứ không phải DEBUG khi có đính kèm mà không đọc được: đây chính là
                // dấu hiệu Zalo đổi định dạng. Để ở DEBUG (log mặc định chạy ở INFO) thì sự cố
                // "ảnh biến mất" không để lại vết nào — đã mất một buổi để tìm ra vì lý do đó.
                if (parsed.keys && !parsed.known) {
                    log.warn(
                        { msg_type: parsed.msgType, reason: parsed.reason, content_keys: parsed.keys },
                        "Tin nhắn có đính kèm nhưng không đọc được — Zalo có thể đã đổi định dạng",
                    );
                } else {
                    log.debug({ msg_type: parsed.msgType, reason: parsed.reason }, "Bỏ qua loại tin nhắn không dùng đến");
                }
                return;
        }

        await this.markMessageSeen();
    }

    private isAllowed(threadId: string, senderId: string): boolean {
        const { ZALO_ALLOWED_THREAD_IDS, ZALO_ALLOWED_SENDER_IDS } = env;

        if (ZALO_ALLOWED_THREAD_IDS.length > 0 && !ZALO_ALLOWED_THREAD_IDS.includes(threadId)) return false;
        if (ZALO_ALLOWED_SENDER_IDS.length > 0 && !ZALO_ALLOWED_SENDER_IDS.includes(senderId)) return false;

        return true;
    }

    /** Ghi mốc tin nhắn cuối — reconnectManager dùng nó để phát hiện khoảng trống tin nhắn. */
    private async markMessageSeen(): Promise<void> {
        await appState().updateOne(
            { _id: APP_STATE_ID },
            { $set: { "zalo_session.last_message_at": new Date(), updated_at: new Date() } },
        );
    }

    /**
     * Số tin đã nhận HÔM NAY từ một nhóm Zalo, theo ngày giờ VN.
     *
     * Đếm thẳng trên `listings` thay vì giữ bộ đếm riêng: bộ đếm riêng phải lo chuyện reset qua
     * nửa đêm và đồng bộ lại sau khi tiến trình chết, còn con số ở đây luôn đúng theo định nghĩa.
     * Lưu lượng chỉ vài tin mỗi phút nên một lần đếm mỗi batch là không đáng kể.
     */
    private async countTodayFromThread(threadId: string): Promise<number> {
        const startOfDay = new Date(`${businessDateKey()}T00:00:00+07:00`);

        return listings().countDocuments({
            "source.thread_id": threadId,
            created_at: { $gte: startOfDay },
        });
    }

    /**
     * Trần thu mỗi ngày của MỘT nhóm Zalo.
     *
     * Mật độ tin giữa các nhóm lệch nhau rất xa, nên một con số chung là lãng phí ở cả hai đầu:
     * nhóm đông tin bị cắt mất phần lớn phòng tốt, còn nhóm thưa tin không dùng hết phần của nó —
     * và suất bỏ phí đó không nhóm nào nhặt lại được vì trần tính riêng theo từng nhóm.
     */
    private capForThread(threadId: string): number {
        return env.LISTINGS_PER_THREAD_OVERRIDES.get(threadId) ?? env.MAX_LISTINGS_PER_THREAD_PER_DAY;
    }

    private async persistBatch(batch: CollectedBatch): Promise<void> {
        const text = batch.texts.join("\n").trim();

        // Batch chỉ có ảnh vẫn được lưu: bước trích xuất còn có thể đọc thông tin từ ảnh.
        // Batch rỗng hoàn toàn thì không có gì để lưu.
        if (text.length === 0 && batch.images.length === 0) return;

        // Trần thu theo NGÀY theo NHÓM. Chặn ở đây — trước khi ghi DB, trước khi tải ảnh, trước
        // khi tạo job trích xuất — nên tin vượt trần không tốn một đồng Gemini nào và cũng không
        // chiếm dung lượng Atlas. Đây là hạn mức cố ý, KHÔNG phải mất dữ liệu do lỗi, nên để mức
        // INFO chứ không WARN; nhưng vẫn phải log để biết mỗi ngày bỏ qua bao nhiêu tin và cân
        // nhắc nới trần.
        const todayCount = await this.countTodayFromThread(batch.threadId);
        const cap = this.capForThread(batch.threadId);

        if (todayCount >= cap) {
            log.info(
                { thread_id: batch.threadId, sender: batch.senderName, today: todayCount, limit: cap },
                "Nhóm này đã đủ hạn mức tin hôm nay — bỏ qua tin mới (không tốn hạn ngạch Gemini)",
            );
            return;
        }

        const batchKey = `${batch.threadId}-${batch.messageIds[0] ?? Date.now()}`;
        const images = await downloadImages(batch.images, batchKey);
        const now = new Date();

        const listing: ListingDoc = {
            source: {
                platform: "zalo",
                thread_id: batch.threadId,
                thread_type: batch.threadType,
                sender_id: batch.senderId,
                sender_name: batch.senderName,
                message_ids: batch.messageIds,
            },
            raw_message: { text, received_at: batch.firstMessageAt },
            images,
            is_listing: null,
            is_listing_reason: null,
            parsed_data: null,
            confidence_score: null,
            missing_required_fields: [],
            extraction_meta: { model: null, prompt_version: null, attempts: 0, last_error: null },
            composed_post: null,
            status: "received",
            status_history: [{ status: "received", at: now, note: null }],
            review: { reviewed_at: null, action: null },
            target_group_ids: [],
            created_at: now,
            updated_at: now,
        };

        let listingId: ObjectId;
        try {
            const result = await listings().insertOne(listing);
            listingId = result.insertedId;
        } catch (error) {
            if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) {
                // Index unique trên message_ids đã chặn: batch này chứa tin nhắn đã được lưu
                // ở lần chạy trước (thường gặp khi service khởi động lại giữa chừng).
                log.warn({ message_ids: batch.messageIds }, "Batch trùng tin nhắn đã lưu, bỏ qua");
                return;
            }
            throw error;
        }

        await incrementDailyMetric("listings_received");
        await enqueueJob({ type: "extract_listing", listingId });

        log.info(
            {
                listing_id: listingId,
                thread_id: batch.threadId,
                sender: batch.senderName,
                text_length: text.length,
                images: images.length,
                messages: batch.messageIds.length,
            },
            "Đã lưu tin đăng mới từ Zalo",
        );
    }
}
