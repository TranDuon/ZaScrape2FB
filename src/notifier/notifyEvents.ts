import type { ObjectId } from "mongodb";
import type { ListingDoc } from "../models/listing.model.js";
import { formatBusinessTime } from "../utils/time.js";
import { sendNotification } from "./telegramBot.js";

/** Ngắn gọn hoá tiền tệ cho tin nhắn: 6500000 -> "6.5 triệu". */
function formatPrice(value: number | null): string {
    if (value === null) return "chưa rõ";
    if (value >= 1_000_000) {
        const millions = value / 1_000_000;
        return `${Number.isInteger(millions) ? millions : millions.toFixed(1)} triệu`;
    }
    return `${value.toLocaleString("vi-VN")}đ`;
}

function shortId(id: ObjectId): string {
    // 6 ký tự cuối đủ để phân biệt và gõ tay nhanh trên điện thoại.
    return id.toHexString().slice(-6);
}

/** Cắt bớt cho vừa một dòng trên điện thoại, không để thông báo tràn màn hình. */
function clip(text: string, max: number): string {
    const trimmed = text.trim().replace(/\s+/g, " ");
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Nhãn ngắn để nhận ra ĐÚNG phòng nào trong thông báo Telegram.
 *
 * Luôn kèm mã 6 ký tự ở cuối: mọi lệnh điều khiển (`/retry`, `/edit`, `/reject`) đều nhận mã đó,
 * nên thông báo mà thiếu mã thì người dùng phải mở `/status` dò lại mới thao tác được.
 *
 * Ưu tiên `title` do model tự đặt — nó chính là chuỗi mô tả ngắn gọn nhất của phòng. Thiếu title
 * thì ghép giá + địa chỉ, vì đó là hai thứ phân biệt được hai phòng cùng một toà nhà.
 */
export function listingLabel(listing: ListingDoc): string {
    const id = listing._id as ObjectId;
    const code = shortId(id);
    const data = listing.parsed_data;

    if (!data) return `#${code}`;

    const place = data.address.raw ?? data.address.ward ?? data.address.district;
    const parts = [
        data.title ? clip(data.title, 60) : formatPrice(data.price_vnd),
        place ? clip(place, 50) : null,
    ].filter((part): part is string => Boolean(part));

    return parts.length > 0 ? `${parts.join(" · ")} [#${code}]` : `#${code}`;
}

/**
 * Đã bóc tách xong một phòng từ Zalo.
 *
 * CHỈ gọi cho tin thật sự đi tiếp (`ready`). Tin `ignored` chiếm phần lớn lưu lượng nhóm Zalo
 * (trò chuyện, banner hoa hồng, tin tuyển CTV) — báo hết thì kênh Telegram thành spam và người
 * dùng bắt đầu bỏ qua cả những thông báo quan trọng. Tin `needs_review` đã có thông báo riêng
 * kèm nút bấm nên cũng không báo trùng ở đây.
 */
export async function notifyExtracted(listing: ListingDoc, groupCount: number | null = null): Promise<void> {
    const images = listing.images.filter((image) => image.storage === "local").length;
    const target = groupCount === null ? "" : ` → sẽ đăng lên ${groupCount} nhóm`;

    await sendNotification(`📥 Đã trích xuất từ Zalo: ${listingLabel(listing)} (${images} ảnh)${target}`);
}

/**
 * Tin đăng cần người duyệt.
 *
 * Kèm nút bấm thay vì bắt gõ lệnh: duyệt tin trên điện thoại mà phải gõ
 * "/approve abc123" thì rất dễ nản và bỏ bê hàng đợi.
 */
export async function notifyNeedsReview(listing: ListingDoc, reason: string): Promise<void> {
    const id = listing._id as ObjectId;
    const data = listing.parsed_data;
    const code = shortId(id);

    const lines = [
        "🔍 TIN ĐĂNG CẦN DUYỆT",
        "",
        `Lý do: ${reason}`,
        `Mã: ${code}`,
        "",
        `Giá: ${formatPrice(data?.price_vnd ?? null)}`,
        `Diện tích: ${data?.area_m2 ? `${data.area_m2}m2` : "chưa rõ"}`,
        `Địa chỉ: ${data?.address.raw ?? data?.address.district ?? "chưa rõ"}`,
        `Liên hệ: ${data?.contact_name ?? "?"} / ${data?.contact_phone ?? "?"}`,
        `Ảnh: ${listing.images.filter((image) => image.storage === "local").length}`,
        `Độ tin cậy: ${listing.confidence_score?.toFixed(2) ?? "?"}`,
        "",
        "Nội dung gốc:",
        listing.raw_message.text.slice(0, 800) || "(không có chữ)",
    ];

    await sendNotification(lines.join("\n"), {
        keyboard: [
            [
                { text: "Duyệt", callback_data: `approve:${id.toHexString()}` },
                { text: "Bỏ qua", callback_data: `reject:${id.toHexString()}` },
            ],
        ],
    });
}

/**
 * Đã đăng xong một bài.
 *
 * Có `label` vì một phòng được đăng lên nhiều nhóm và nhiều phòng chạy xen kẽ nhau trong ngày:
 * thông báo chỉ có tên nhóm thì không thể biết bài vừa lên là phòng nào.
 */
export async function notifyPosted(label: string, groupName: string, imageCount: number): Promise<void> {
    await sendNotification(`✅ Đã đăng ${label}\n   lên nhóm "${groupName}" (${imageCount} ảnh)`);
}

export async function notifyPostFailed(groupName: string, error: string): Promise<void> {
    await sendNotification(`⚠️ Không đăng được lên "${groupName}"\n\n${error}`);
}

/**
 * Cảnh báo khẩn khi Facebook chặn.
 *
 * Viết rõ việc cần làm chứ không chỉ báo lỗi: lúc nhận tin này người dùng thường
 * đang làm việc khác, cần biết ngay phải làm gì.
 */
export async function notifyCircuitBreakerTripped(reason: string, screenshotPath: string | null): Promise<void> {
    const lines = [
        "🛑 ĐÃ DỪNG ĐĂNG BÀI LÊN FACEBOOK",
        "",
        reason,
        "",
        `Thời điểm: ${formatBusinessTime()}`,
        screenshotPath ? `Ảnh chụp màn hình: ${screenshotPath}` : "",
        "",
        "Việc cần làm:",
        "1. Mở Facebook bằng tay, kiểm tra tài khoản có bị hạn chế gì không",
        "2. Xử lý xong xuôi thì gõ /resume để chạy lại",
        "",
        "Agent sẽ KHÔNG tự thử lại cho tới khi bạn xác nhận.",
    ];

    await sendNotification(lines.filter(Boolean).join("\n"));
}

export async function notifyZaloIssue(message: string): Promise<void> {
    await sendNotification(`⚠️ ZALO\n\n${message}`);
}

export async function notifyStartup(summary: Record<string, unknown>): Promise<void> {
    const lines = ["🚀 Agent đã khởi động", "", ...Object.entries(summary).map(([key, value]) => `${key}: ${value}`)];
    await sendNotification(lines.join("\n"));
}
