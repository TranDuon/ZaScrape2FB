import type { API, Message } from "zca-js";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { formatBusinessTime } from "../utils/time.js";
import { parseIncomingMessage } from "./messageParser.js";

const log = childLogger("zalo:dm-alert");

/** Danh sách bạn bè đổi chậm; tải lại sau ngần này để người vừa kết bạn không bị gọi là người lạ mãi. */
const FRIENDS_REFRESH_MS = 6 * 60 * 60 * 1000;
const PREVIEW_MAX_LENGTH = 300;

export type NotifyFn = (message: string) => Promise<void> | void;

/** Nhãn cho các loại tin không phải chữ — đủ để biết khách gửi gì mà không cần mở Zalo. */
const KNOWN_ATTACHMENTS: Array<[RegExp, string]> = [
    [/sticker/i, "[Sticker]"],
    [/voice/i, "[Tin nhắn thoại]"],
    [/video/i, "[Video]"],
    [/file|doc/i, "[File]"],
    [/location/i, "[Vị trí]"],
    [/recommend|link/i, "[Danh thiếp / đường link]"],
    [/gif/i, "[GIF]"],
];

/** Tóm tắt nội dung một tin để nhét vào thông báo. Hàm thuần, tách ra để test. */
export function describeMessage(message: Message): string {
    const parsed = parseIncomingMessage(message);

    if (parsed.kind === "text") {
        const text = parsed.text.trim().replace(/\s+/g, " ");
        return text.length > PREVIEW_MAX_LENGTH ? `${text.slice(0, PREVIEW_MAX_LENGTH - 1)}…` : text;
    }
    if (parsed.kind === "image") return "[Ảnh]";

    for (const [pattern, label] of KNOWN_ATTACHMENTS) {
        if (pattern.test(parsed.msgType)) return label;
    }
    return "[Tin nhắn đính kèm]";
}

export interface CooldownDecision {
    notify: boolean;
    /** Số tin đã bị gộp (không báo) kể từ lần báo trước — báo kèm để người dùng biết khách nhắn dồn. */
    suppressed: number;
}

/**
 * Chặn báo dồn: mỗi người chỉ một thông báo trong một khoảng nguội.
 *
 * Khách hay nhắn thành nhiều dòng ngắn liên tiếp ("chào bạn" / "phòng còn không" / "giá bao nhiêu").
 * Báo từng dòng thì Telegram ngập và người dùng quen tay bỏ qua — đúng thứ tính năng này sinh ra để
 * chống. Tin ĐẦU TIÊN luôn được báo ngay, vì báo sớm mới là mục tiêu.
 */
export class SenderCooldown {
    private readonly state = new Map<string, { lastNotifiedAt: number; suppressed: number }>();

    constructor(private readonly cooldownMs: number) {}

    check(senderKey: string, now: number): CooldownDecision {
        const entry = this.state.get(senderKey);

        if (entry && now - entry.lastNotifiedAt < this.cooldownMs) {
            entry.suppressed += 1;
            return { notify: false, suppressed: entry.suppressed };
        }

        const suppressed = entry?.suppressed ?? 0;
        this.state.set(senderKey, { lastNotifiedAt: now, suppressed: 0 });
        return { notify: true, suppressed };
    }
}

/**
 * Báo tin nhắn riêng (1-1) gửi tới tài khoản Zalo của agent lên Telegram.
 *
 * Chính số này được in trên mọi bài đăng (AGENT_CONTACT_PHONE), nên khách xem bài xong sẽ nhắn vào
 * đây — và phần lớn là người lạ, mà Zalo dồn tin của người lạ vào một mục riêng rất dễ bị sót.
 *
 * Chỉ ĐỌC và BÁO, không bao giờ tự trả lời: tự trả lời bằng tài khoản cá nhân qua API không chính
 * thức là cách nhanh nhất để Zalo khoá số.
 */
export class DirectMessageAlert {
    private api: API | null = null;
    private friendIds: Set<string> | null = null;
    private friendsLoadedAt = 0;
    private friendsLoading: Promise<void> | null = null;
    private readonly cooldown = new SenderCooldown(env.ZALO_DM_ALERT_COOLDOWN_MINUTES * 60_000);

    constructor(private readonly notify: NotifyFn) {}

    /** Gọi mỗi lần (tái) kết nối — API cũ không dùng được sau khi listener khởi động lại. */
    setApi(api: API): void {
        this.api = api;
        this.friendsLoadedAt = 0;
        void this.refreshFriends();
    }

    async handle(message: Message): Promise<void> {
        if (!env.ZALO_DM_ALERT_ENABLED) return;

        const senderId = message.data.uidFrom;
        const decision = this.cooldown.check(message.threadId, Date.now());
        if (!decision.notify) {
            log.debug({ sender_id: senderId }, "Tin riêng trong khoảng nguội — gộp, không báo lại");
            return;
        }

        if (Date.now() - this.friendsLoadedAt > FRIENDS_REFRESH_MS) await this.refreshFriends();

        const name = message.data.dName || senderId;
        const relation =
            this.friendIds === null ? "chưa rõ bạn bè hay người lạ" : this.friendIds.has(senderId) ? "bạn bè" : "NGƯỜI LẠ";
        const sentAt = formatBusinessTime(new Date(parseInt(message.data.ts, 10)));
        const preview = describeMessage(message);

        log.info({ sender_id: senderId, sender: name, relation }, "Có tin nhắn riêng trên Zalo — báo Telegram");

        const lines = [
            `💬 Zalo: tin nhắn mới từ ${relation}`,
            `Người gửi: ${name}`,
            `Lúc: ${sentAt}`,
            `Nội dung: ${preview}`,
            decision.suppressed > 0 ? `(+${decision.suppressed} tin trước đó trong lúc chờ, chưa báo)` : "",
            relation === "NGƯỜI LẠ" ? "Mở Zalo → mục \"Tin nhắn từ người lạ\" để trả lời." : "Mở Zalo để trả lời.",
        ];

        await this.notify(lines.filter(Boolean).join("\n"));
    }

    /**
     * Tải danh sách bạn bè để phân biệt người lạ. Lỗi thì giữ danh sách cũ (hoặc "chưa rõ") chứ không
     * chặn thông báo: báo thiếu nhãn còn hơn không báo.
     */
    private async refreshFriends(): Promise<void> {
        if (!this.api) return;
        if (this.friendsLoading) return this.friendsLoading;

        const api = this.api;
        this.friendsLoading = (async () => {
            try {
                const friends = await api.getAllFriends();
                this.friendIds = new Set(friends.map((friend) => friend.userId));
                this.friendsLoadedAt = Date.now();
                log.info({ friends: this.friendIds.size }, "Đã tải danh sách bạn bè Zalo (để nhận ra người lạ)");
            } catch (error) {
                // Không thử lại ngay: đánh dấu đã thử để không gọi API mỗi tin nhắn khi Zalo đang lỗi.
                this.friendsLoadedAt = Date.now();
                log.warn({ err: error }, "Không tải được danh sách bạn bè Zalo — thông báo sẽ không phân biệt người lạ");
            } finally {
                this.friendsLoading = null;
            }
        })();

        return this.friendsLoading;
    }
}
