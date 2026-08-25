import { childLogger } from "../utils/logger.js";
import type { PendingImage } from "./mediaDownloader.js";

const log = childLogger("zalo:batcher");

export interface BatchSource {
    threadId: string;
    threadType: number;
    senderId: string;
    senderName: string;
}

export interface CollectedBatch extends BatchSource {
    /** Khoá gom nhóm: cùng thread VÀ cùng người gửi mới được gộp chung. */
    key: string;
    texts: string[];
    images: PendingImage[];
    messageIds: string[];
    firstMessageAt: Date;
    lastMessageAt: Date;
}

interface OpenBatch extends CollectedBatch {
    idleTimer: NodeJS.Timeout;
    hardTimer: NodeJS.Timeout;
}

export type FlushHandler = (batch: CollectedBatch) => Promise<void>;

/**
 * Độ dài tối đa để coi một tin chữ là "nhãn phòng" chứ không phải tin đăng đầy đủ.
 *
 * Đo trên dữ liệu thật: tin đăng đầy đủ (địa chỉ + giá + nội thất + dịch vụ + lưu ý) dài
 * trung bình ~295 ký tự, trong khi nhãn phòng dạng "P201 - 4tr2" chỉ ~11 ký tự. Khoảng cách
 * quá lớn nên ngưỡng 80 không nằm gần ranh giới nào cả — không sợ phân loại nhầm.
 */
const LABEL_MAX_LENGTH = 80;

/** Nhãn phòng có phải chỉ là mã phòng/giá không — dùng để quyết định có kế thừa ngữ cảnh. */
function isRoomLabel(text: string): boolean {
    return text.trim().length <= LABEL_MAX_LENGTH;
}

/**
 * Gom các tin nhắn rời rạc thành một tin đăng.
 *
 * RANH GIỚI GIỮA HAI PHÒNG LÀ TIN CHỮ, KHÔNG PHẢI KHOẢNG LẶNG THỜI GIAN.
 *
 * Quy tắc bám đúng cấu trúc người ta gửi:
 *   - Gặp tin CHỮ ĐẦY ĐỦ (dài hơn LABEL_MAX_LENGTH) -> chốt batch đang mở, mở batch mới, và
 *     ghi nhớ làm ngữ cảnh cho các nhãn phòng phía sau.
 *   - Gặp tin CHỮ NGẮN (nhãn phòng kiểu "P201 - 4tr2") KHI batch đang mở ĐÃ có ảnh -> chốt
 *     batch đó, mở batch mới cho phòng mới, KẾ THỪA tin chữ đầy đủ gần nhất để có địa chỉ.
 *   - Gặp tin CHỮ NGẮN khi batch đang mở CHƯA có ảnh -> đây là lời nhắn thêm về chính phòng
 *     vừa gửi, nối vào batch đang mở, KHÔNG chốt.
 *   - Gặp tin ẢNH  -> nối vào batch đang mở. Chỉ bị bỏ khi thật sự không có batch nào mở
 *     (ảnh đến trước bất kỳ tin chữ nào).
 *
 * Hai mốc thời gian vẫn giữ làm lưới an toàn:
 * - idle window: chốt batch cuối cùng khi người gửi đã gửi xong.
 * - hard cap: batch mở quá lâu cũng phải chốt, tránh treo vô hạn.
 */
export class MessageBatcher {
    private readonly batches = new Map<string, OpenBatch>();

    /**
     * Tin chữ ĐẦY ĐỦ gần nhất của mỗi người gửi, giữ lại để nhãn phòng ngắn kế thừa.
     *
     * Sống lâu hơn batch (không xoá khi flush) vì nhãn phòng thường tới SAU khi batch của tin
     * đầy đủ đã chốt. Kích thước bị chặn bởi số người gửi trong các nhóm đang theo dõi.
     */
    private readonly lastFullText = new Map<string, string>();

    constructor(
        private readonly idleWindowMs: number,
        private readonly maxWindowMs: number,
        private readonly onFlush: FlushHandler,
    ) {}

    static keyOf(source: BatchSource): string {
        return `${source.threadId}:${source.senderId}`;
    }

    /**
     * Tin chữ = ranh giới phòng mới. Luôn chốt batch cũ trước khi mở batch mới.
     *
     * NGOẠI LỆ QUAN TRỌNG: tin chữ NGẮN đến khi batch đang mở CHƯA có tấm ảnh nào thì không
     * phải nhãn phòng mới — nó là phần viết thêm của chính tin vừa gửi, nên được nhập vào batch
     * đang mở thay vì chốt batch đó. Còn nhãn ngắn đến khi batch ĐÃ có ảnh thì đúng là phòng
     * mới: mở batch mới và kế thừa tin chữ đầy đủ gần nhất để phòng đó có địa chỉ.
     *
     * Phân biệt bằng "batch đã có ảnh hay chưa" chứ không bằng độ dài, vì đó mới đúng là dấu
     * hiệu của hai tình huống khác nhau trong dữ liệu thật:
     *   - [chữ đầy đủ][ảnh...][nhãn ngắn][ảnh...]  -> nhãn ngắn MỞ phòng mới (batch đã có ảnh)
     *   - [chữ đầy đủ][chữ ngắn][ảnh...]           -> chữ ngắn VIẾT THÊM cho phòng đó (chưa có ảnh)
     *
     * Không có ngoại lệ này thì tình huống thứ hai chốt batch của tin phòng lúc nó còn 0 ảnh,
     * rồi vứt luôn tin ngắn (nhãn phòng không mở batch mới) — và mọi ảnh gửi sau đó không còn
     * batch nào để vào nên mất sạch. Đây là lỗi thật ngày 23/08/2026: tin phòng vào DB với
     * images: 0 kèm 20 dòng WARN "Ảnh đến khi không có batch nào đang mở".
     */
    addText(source: BatchSource, messageId: string, text: string, timestamp: Date): void {
        const key = MessageBatcher.keyOf(source);
        const existing = this.batches.get(key);
        const label = isRoomLabel(text);

        if (existing && label && existing.images.length === 0) {
            existing.texts.push(text);
            this.touch(existing, messageId, timestamp);
            log.debug({ text: text.trim() }, "Tin chữ ngắn khi chưa có ảnh — viết thêm cho phòng đang mở");
            return;
        }

        if (existing) void this.flush(key);

        const batch = this.open(source, timestamp);

        if (label) {
            // Nhãn phòng MỞ phòng mới và KẾ THỪA tin chữ đầy đủ gần nhất của cùng người gửi.
            //
            // Đây là hình dạng thứ hai trong dữ liệu thật: `[chữ đầy đủ][ảnh…][P303][ảnh…]` —
            // "P303" đúng là phòng khác, nhưng bản thân nó chỉ có mã phòng, không có địa chỉ hay
            // giá, nên nếu đứng một mình thì bài đăng sinh ra vô dụng. Kế thừa phần chữ đầy đủ
            // phía trước cho nó đủ ngữ cảnh (địa chỉ toà nhà) mà vẫn là một phòng riêng, có
            // thư mục ảnh riêng.
            //
            // Trước đây nhãn bị bỏ hẳn và KHÔNG mở batch mới, nên mọi ảnh đi sau nhãn rơi vào hư
            // không — 23/08/2026 mất trắng 4 ảnh của phòng "P303" theo đúng đường này.
            const context = this.lastFullText.get(key);

            if (context) {
                batch.texts.push(context);
            } else {
                // Không có ngữ cảnh trước đó (agent vừa khởi động, hoặc nhãn là tin đầu tiên):
                // vẫn giữ ảnh lại, nhưng báo để biết tin này nhiều khả năng thiếu địa chỉ.
                log.warn(
                    { label: text.trim() },
                    "Nhãn phòng ngắn nhưng chưa có tin chữ đầy đủ nào trước đó — phòng này sẽ thiếu địa chỉ",
                );
            }

            batch.texts.push(text);
        } else {
            // Tin chữ đầy đủ: mở phòng mới, đồng thời làm ngữ cảnh cho các nhãn phòng phía sau.
            batch.texts.push(text);
            this.lastFullText.set(key, text);
        }

        this.touch(batch, messageId, timestamp);
    }

    /**
     * Ảnh luôn thuộc về phần chữ đứng ngay trước nó.
     * Nếu không có batch nào đang mở (nhãn phòng ngắn vừa bị bỏ qua, hoặc ảnh đến
     * trước bất kỳ tin chữ đầy đủ nào) thì ảnh cũng bị bỏ qua.
     */
    addImage(source: BatchSource, messageId: string, image: PendingImage, timestamp: Date): void {
        const key = MessageBatcher.keyOf(source);
        const batch = this.batches.get(key);

        if (!batch) {
            // WARN chứ không DEBUG: mỗi dòng này là một tấm ảnh của phòng thật bị mất. Thà ồn
            // một chút còn hơn để ảnh biến mất im lặng như sự cố 23/08/2026 (xem messageParser).
            log.warn({ key }, "Ảnh đến khi không có batch nào đang mở — bỏ qua");
            return;
        }

        batch.images.push(image);
        this.touch(batch, messageId, timestamp);
    }

    /** Chốt toàn bộ batch đang mở — dùng khi tắt service để không mất dữ liệu. */
    async flushAll(): Promise<void> {
        const keys = [...this.batches.keys()];
        for (const key of keys) await this.flush(key);
    }

    get openCount(): number {
        return this.batches.size;
    }

    private open(source: BatchSource, timestamp: Date): OpenBatch {
        const key = MessageBatcher.keyOf(source);

        const batch: OpenBatch = {
            key,
            threadId: source.threadId,
            threadType: source.threadType,
            senderId: source.senderId,
            senderName: source.senderName,
            texts: [],
            images: [],
            messageIds: [],

            firstMessageAt: timestamp,
            lastMessageAt: timestamp,
            idleTimer: setTimeout(() => void this.flush(key), this.idleWindowMs),
            // Hẹn giờ trần được đặt một lần lúc mở batch và KHÔNG gia hạn,
            // nếu không thì người gửi rả rích sẽ giữ batch mở mãi mãi.
            hardTimer: setTimeout(() => void this.flush(key), this.maxWindowMs),
        };

        this.batches.set(key, batch);
        return batch;
    }

    private touch(batch: OpenBatch, messageId: string, timestamp: Date): void {
        batch.messageIds.push(messageId);

        if (timestamp.getTime() > batch.lastMessageAt.getTime()) {
            batch.lastMessageAt = timestamp;
        }

        clearTimeout(batch.idleTimer);
        batch.idleTimer = setTimeout(() => void this.flush(batch.key), this.idleWindowMs);
    }

    private async flush(key: string): Promise<void> {
        const batch = this.batches.get(key);
        if (!batch) return;

        // Gỡ khỏi map TRƯỚC khi xử lý: tin nhắn đến trong lúc đang lưu DB
        // sẽ mở batch mới thay vì bị gộp nhầm vào batch đang đóng dở.
        this.batches.delete(key);
        clearTimeout(batch.idleTimer);
        clearTimeout(batch.hardTimer);

        if (batch.messageIds.length === 0) return;

        const { idleTimer: _idle, hardTimer: _hard, ...collected } = batch;

        try {
            await this.onFlush(collected);
        } catch (error) {
            log.error({ err: error, key, message_ids: collected.messageIds }, "Xử lý batch thất bại");
        }
    }
}
