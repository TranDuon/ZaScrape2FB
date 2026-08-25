import type { Message } from "zca-js";

/**
 * Phân loại một tin nhắn Zalo thô về dạng dùng được cho pipeline.
 *
 * Thực tế quan sát được: người gửi đăng phần chữ trước, rồi album ảnh đến ngay sau
 * dưới dạng NHIỀU tin nhắn riêng biệt (mỗi ảnh một tin) — nên bộ gom batch phải
 * ghép chúng lại, và hàm này chỉ chịu trách nhiệm nhận dạng từng tin một.
 */
export type ParsedIncoming =
    | { kind: "text"; text: string }
    | { kind: "image"; url: string; thumb: string | null }
    /**
     * `reason`/`keys` để khi Zalo đổi định dạng thì log nói được NGAY là đổi cái gì.
     * Trước đây nhánh này chỉ mang `msgType`, nên một thay đổi phía Zalo chỉ biểu hiện ra
     * ngoài dưới dạng "ảnh biến mất" mà không có manh mối nào trong log.
     *
     * `known: true` = loại tin nhận ra được và cố ý bỏ qua (sticker, video…), KHÔNG phải sự cố.
     * Phân biệt để cảnh báo "Zalo đổi định dạng" chỉ kêu khi thật sự có gì đó lạ.
     */
    | { kind: "other"; msgType: string; reason: string; keys?: string[]; known?: boolean };

interface AttachmentLike {
    href?: unknown;
    thumb?: unknown;
    title?: unknown;
    description?: unknown;
    params?: unknown;
}

function asString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

/** Đuôi file ảnh trong URL — cứu cánh khi cả msgType lẫn params đều không nhận ra được. */
const IMAGE_URL_PATTERN = /\.(jpe?g|png|webp|gif)(\?|$)/i;

interface ImageCandidate {
    url: string | null;
    /** URL lấy từ `params` (hd/normal/origin) — chỉ tin nhắn ảnh mới có cấu trúc này. */
    fromParams: boolean;
}

/**
 * Ảnh chất lượng cao nằm trong `params` (chuỗi JSON) chứ không phải `href`.
 * Ưu tiên bản gốc để bài đăng Facebook không bị mờ; rơi về href/thumb nếu không có.
 */
function findImageUrl(content: AttachmentLike): ImageCandidate {
    const params = asString(content.params);
    if (params) {
        try {
            const parsed = JSON.parse(params) as Record<string, unknown>;
            const candidate = asString(parsed.hd) ?? asString(parsed.normal) ?? asString(parsed.origin);
            if (candidate) return { url: candidate, fromParams: true };
        } catch {
            // params không phải JSON hợp lệ — bỏ qua, dùng href bên dưới.
        }
    }
    return { url: asString(content.href) ?? asString(content.thumb), fromParams: false };
}

/**
 * Loại đính kèm nhận ra được nhưng cố ý không dùng cho tin đăng.
 *
 * Phải nhận diện tường minh vì HAI lý do, và lý do thứ hai mới là lý do nghiêm trọng:
 *
 * 1. Nhóm thật đầy sticker và video; nếu mỗi cái đều kêu WARN "Zalo có thể đã đổi định dạng"
 *    thì đúng cái cảnh báo dùng để phát hiện sự cố thật bị chôn trong nhiễu.
 * 2. `chat.video.msg` mang cả `title` lẫn `description`. Không chặn ở đây thì nó rơi xuống
 *    nhánh title/description → thành `kind: "text"` → chốt mất batch đang mở → bị vứt như nhãn
 *    phòng, kéo theo toàn bộ ảnh/video phía sau. Ngày 23/08/2026 nó thoát chỉ vì hai field đó
 *    tình cờ rỗng — đúng con bug đã sửa cho ảnh, vẫn còn nguyên với video.
 */
const KNOWN_SKIPPED_TYPES: Array<{ match: string; reason: string }> = [
    { match: "video", reason: "video — chưa hỗ trợ tải về, chỉ bỏ qua chứ không phá batch" },
    { match: "sticker", reason: "sticker" },
    { match: "voice", reason: "tin nhắn thoại" },
    { match: "file", reason: "tệp đính kèm" },
    { match: "location", reason: "vị trí" },
];

function knownSkipReason(msgType: string): string | null {
    const lowered = msgType.toLowerCase();
    return KNOWN_SKIPPED_TYPES.find((entry) => lowered.includes(entry.match))?.reason ?? null;
}

/**
 * Phân loại một tin nhắn Zalo thô.
 *
 * ĐIỂM MẤU CHỐT: tin đính kèm KHÔNG BAO GIỜ được rơi xuống thành `kind: "text"` chỉ vì có
 * `title`. Trong bộ gom batch, một tin chữ là RANH GIỚI GIỮA HAI PHÒNG — nên một tin ảnh bị
 * đọc nhầm thành chữ sẽ chốt luôn batch đang mở, và vì `title` của ảnh chỉ là tên file (ngắn
 * hơn ngưỡng nhãn phòng) nên nó bị vứt, kéo theo toàn bộ ảnh đi sau cũng mất.
 *
 * Đây là lỗi đã xảy ra thật (23/08/2026): mọi tin đăng đều được lưu với `images: 0` và bị chốt
 * ngay lập tức thay vì sau cửa sổ chờ, còn `data/images/` thì rỗng hoàn toàn. Nhận dạng ảnh vì
 * vậy không được phụ thuộc riêng vào `msgType`: nếu Zalo đổi tên loại tin thì phải còn hai
 * đường khác nhận ra, và khi cả ba đều trượt thì trả về `other` (vô hại) chứ không phải `text`.
 */
export function parseIncomingMessage(message: Message): ParsedIncoming {
    const { content, msgType } = message.data;

    if (typeof content === "string") {
        const text = content.trim();
        return text.length > 0 ? { kind: "text", text } : { kind: "other", msgType, reason: "chữ rỗng" };
    }

    if (content && typeof content === "object") {
        const attachment = content as AttachmentLike;
        const keys = Object.keys(attachment);
        const { url, fromParams } = findImageUrl(attachment);

        const byType = msgType.includes("photo") || msgType.includes("image");
        const looksLikeImage = byType || fromParams || (url !== null && IMAGE_URL_PATTERN.test(url));

        if (looksLikeImage && url) {
            return { kind: "image", url, thumb: asString(attachment.thumb) };
        }

        // Nhìn ra là ảnh nhưng không moi được URL: trả `other` để tin bị bỏ qua lặng lẽ,
        // TUYỆT ĐỐI không trả `text` — trả `text` là phá vỡ ranh giới phòng (xem chú thích trên).
        if (looksLikeImage) {
            return { kind: "other", msgType, reason: "là ảnh nhưng không lấy được URL", keys };
        }

        // PHẢI đứng TRƯỚC nhánh title/description: video mang cả hai field đó, để lọt xuống dưới
        // là nó biến thành "text" và phá vỡ ranh giới phòng (xem KNOWN_SKIPPED_TYPES).
        const skipReason = knownSkipReason(msgType);
        if (skipReason) {
            return { kind: "other", msgType, reason: skipReason, known: true };
        }

        // Tin nhắn dạng link/recommend vẫn có chữ hữu ích trong title + description.
        const title = asString(attachment.title);
        const description = asString(attachment.description);
        if (title || description) {
            return { kind: "text", text: [title, description].filter(Boolean).join("\n") };
        }

        return { kind: "other", msgType, reason: "đính kèm không nhận dạng được", keys };
    }

    return { kind: "other", msgType, reason: "nội dung không phải chữ cũng không phải đính kèm" };
}
