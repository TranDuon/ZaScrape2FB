import { Type, type Schema } from "@google/genai";
import { z } from "zod";
import { env } from "../config/env.js";
import type { ListingParsedData } from "../models/listing.model.js";

/** Tăng khi sửa prompt để biết một bài đăng cũ được sinh bằng phiên bản nào. */
export const COMPOSER_PROMPT_VERSION = "v1";

export const COMPOSER_SYSTEM_INSTRUCTION = `Bạn là một môi giới phòng trọ chuyên nghiệp, viết bài đăng cho thuê phòng trên các hội nhóm Facebook tại Việt Nam.

MỤC TIÊU:
Viết bài ngắn gọn, trực diện, đúng trọng tâm để người thuê đọc lướt qua nắm trọn thông tin ngay và liên hệ ngay lập tức.

TIÊU CHUẨN TRÌNH BÀY:
- Độ dài: Ngắn gọn, súc tích (dưới 100-120 từ mỗi bài).
- Icon/Emoji: Tối giản, chỉ dùng dấu gạch đầu dòng (-) hoặc dấu chấm tròn (•), hạn chế tối đa emoji màu mè rườm rà.
- Trình bày: Rõ ràng, dễ nhìn trên màn hình điện thoại, phân dòng rành mạch.
- Độ chính xác: Chỉ sử dụng dữ liệu được cung cấp (giá, dịch vụ, nội thất, vị trí, liên hệ...). Tuyệt đối KHÔNG tự bịa thêm thông tin ngoài dữ liệu.
- Vị trí: Viết theo ngõ/ngách/đường/quận (KHÔNG ghi số nhà cụ thể để bảo mật).

CẤU TRÚC BÀI ĐĂNG GỒM:
1. TIÊU ĐỀ: [LOẠI PHÒNG] + [NGÕ/ĐƯỜNG] + [QUẬN] (In hoa ngắn gọn)
2. THÔNG TIN CHÍNH:
   • Giá thuê & Hình thức cọc (Cọc/đóng)
   • Tình trạng phòng / Thời gian trống
   • Loại phòng (Studio/Gác xép), Thang máy/Thang bộ
   • Nội thất sẵn có
3. CHI PHÍ DỊCH VỤ: Điện, nước, dịch vụ chung, wifi (ghi rõ đơn vị tính).
4. LƯU Ý: Giới hạn xe, giờ giấc, hẹn xem phòng trước 30 phút (nếu có).
5. LIÊN HỆ: SĐT / Zalo [Số điện thoại].

QUY ĐỊNH TẠO NHIỀU BIẾN THỂ:
Nếu yêu cầu tạo nhiều biến thể cho một phòng để đăng nhiều nhóm, các bài phải thay đổi linh hoạt:
- Cách giật tiêu đề
- Thứ tự sắp xếp các dòng thông tin (đưa giá lên đầu, hoặc đưa nội thất/vị trí lên đầu)
- Cách hành văn (vẫn giữ dữ liệu gốc không đổi)

XỬ LÝ NHIỀU PHÒNG:
Nếu đầu vào có nhiều phòng (phân tách bởi "=== PHÒNG #n ===" hoặc theo mã), xử lý độc lập từng phòng, tuyệt đối không lẫn lộn dữ liệu giữa các phòng.`;

const VARIATIONS_SCHEMA: Schema = {
    type: Type.ARRAY,
    description: "Danh sách các biến thể bài đăng, mỗi biến thể cho một nhóm Facebook khác nhau",
    items: {
        type: Type.OBJECT,
        properties: {
            text: {
                type: Type.STRING,
                description: "Toàn bộ nội dung bài đăng, KHÔNG bao gồm hashtag ở cuối",
            },
            hashtags: {
                type: Type.ARRAY,
                description: "4-6 hashtag, mỗi phần tử bắt đầu bằng dấu #",
                items: { type: Type.STRING },
            },
        },
        required: ["text", "hashtags"],
    },
};

/**
 * Nhiều phòng trong một lần gọi. `index` là thứ giữ bài viết không bị gán nhầm phòng: ghép kết
 * quả theo số hiệu model chép lại, KHÔNG theo thứ tự mảng — gán nhầm ở đây nghĩa là đăng lên
 * Facebook bài có địa chỉ phòng này kèm số điện thoại/giá của phòng khác.
 */
export const COMPOSER_RESPONSE_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {
        items: {
            type: Type.ARRAY,
            description: "Kết quả cho TỪNG phòng, mỗi phòng một phần tử, không gộp, không bỏ sót",
            items: {
                type: Type.OBJECT,
                properties: {
                    index: {
                        type: Type.INTEGER,
                        description: "Số hiệu phòng, chép đúng con số trong tiêu đề '=== PHÒNG #n ===' của phòng đó",
                    },
                    variations: VARIATIONS_SCHEMA,
                },
                required: ["index", "variations"],
            },
        },
    },
    required: ["items"],
};

const variationsSchema = z
    .array(
        z.object({
            text: z.string().min(1),
            hashtags: z
                .union([z.array(z.string()), z.null()])
                .optional()
                .transform((tags) =>
                    Array.isArray(tags)
                        ? tags
                            .map((tag) => tag.trim())
                            .filter(Boolean)
                            // Model đôi khi quên dấu # — tự thêm vào thay vì loại bỏ hashtag hợp lệ.
                            .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
                        : [],
                ),
        }),
    )
    .min(1, "Phải có ít nhất một biến thể");

export const composerSchema = z.object({
    items: z.array(z.object({ index: z.coerce.number().int(), variations: variationsSchema })),
});

export type ComposerResult = z.infer<typeof composerSchema>;

function formatMoney(value: number | null): string | null {
    if (value === null) return null;
    return `${value.toLocaleString("vi-VN")}đ`;
}

/**
 * Gói dữ liệu đã bóc tách thành mô tả dạng chữ cho model.
 *
 * Chỉ đưa vào những field CÓ giá trị: liệt kê cả field null sẽ khiến model có xu hướng
 * viết "đang cập nhật" cho từng mục trống, làm bài đăng loãng và kém tin cậy.
 */
export function describeListing(data: ListingParsedData): string {
    const lines: string[] = [];

    const add = (label: string, value: string | number | null | undefined): void => {
        if (value === null || value === undefined || value === "") return;
        lines.push(`- ${label}: ${value}`);
    };

    add("Loại hình", data.room_type);
    add("Giá thuê mỗi tháng", formatMoney(data.price_vnd));
    add("Diện tích", data.area_m2 ? `${data.area_m2}m2` : null);
    add("Địa chỉ", data.address.raw);
    add("Phường/xã", data.address.ward);
    add("Quận/huyện", data.address.district);
    add("Tỉnh/thành phố", data.address.city);
    add("Tiền cọc", formatMoney(data.deposit_vnd));
    add("Thời điểm vào ở được", data.available_from);

    add("Nội thất", data.furniture.summary);
    if (data.furniture.items.length > 0) add("Nội thất chi tiết", data.furniture.items.join(", "));
    if (data.amenities.length > 0) add("Tiện ích", data.amenities.join(", "));

    add("Giá điện", data.utilities.electricity_price);
    add("Giá nước", data.utilities.water_price);
    add("Wifi", data.utilities.wifi_price);
    add("Phí dịch vụ", data.utilities.service_fee);

    const rules = data.house_rules;
    add("Điều khoản cọc", rules.deposit_terms);
    if (rules.pet_allowed !== null) add("Thú cưng", rules.pet_allowed ? "được nuôi" : "không được nuôi");
    add("Giới hạn người/xe", rules.vehicle_limit);
    if (rules.foreigner_allowed !== null) {
        add("Khách nước ngoài", rules.foreigner_allowed ? "có nhận" : "không nhận");
    }
    if (rules.visit_notice_minutes !== null) add("Báo trước khi xem phòng", `${rules.visit_notice_minutes} phút`);
    if (rules.other_rules.length > 0) add("Quy định khác", rules.other_rules.join("; "));

    add("Ghi chú thêm", data.notes);

    return lines.join("\n");
}

/**
 * Thông tin liên hệ hiển thị trên bài đăng.
 *
 * Ưu tiên AGENT_CONTACT_* trong .env: người dùng là bên đăng lại tin từ nhóm nguồn,
 * nên bài trên Facebook phải để số của họ, không phải số của người báo phòng ban đầu.
 */
export function resolveContact(data: ListingParsedData): { name: string | null; phone: string | null } {
    const name = env.AGENT_CONTACT_NAME.trim() || data.contact_name;
    const phone = env.AGENT_CONTACT_PHONE.trim() || data.contact_phone;
    return { name: name || null, phone: phone || null };
}

export interface ComposerItem {
    data: ListingParsedData;
    imageCount: number;
    /**
     * Số biến thể cần cho RIÊNG phòng này = số nhóm nó sẽ được đăng lên.
     *
     * Phải theo từng phòng chứ không dùng chung một con số cho cả lô: độ phủ nhóm mỗi quận rất
     * khác nhau (Thanh Xuân 10 nhóm, Hà Đông 1 nhóm), nên lấy số lớn nhất của lô áp cho tất cả
     * là bắt model viết thừa hàng loạt bài không ai dùng — mà output chính là phần đắt nhất.
     */
    variationCount: number;
}

/** Khối mô tả một phòng trong prompt. `index` bắt đầu từ 1, khớp field `index` model trả về. */
function buildListingBlock(item: ComposerItem, index: number): string {
    const contact = resolveContact(item.data);
    const sections: string[] = [];

    sections.push(`=== PHÒNG #${index} ===`);
    sections.push(`THÔNG TIN PHÒNG:\n${describeListing(item.data)}`);

    const contactLines: string[] = [];
    if (contact.name) contactLines.push(`- Tên người liên hệ: ${contact.name}`);
    if (contact.phone) contactLines.push(`- Số điện thoại: ${contact.phone}`);

    if (contactLines.length > 0) {
        sections.push(
            `THÔNG TIN LIÊN HỆ (bắt buộc đưa vào cuối mỗi biến thể, giữ nguyên chính xác):\n${contactLines.join("\n")}`,
        );
    } else {
        sections.push(
            "KHÔNG có thông tin liên hệ. Kết bài bằng lời mời nhắn tin trực tiếp, KHÔNG bịa số điện thoại.",
        );
    }

    if (item.imageCount > 0) {
        sections.push(`Bài đăng sẽ kèm ${item.imageCount} ảnh thật của phòng, nên không cần mô tả lại ảnh bằng chữ.`);
    }

    // Số biến thể ghi ngay trong khối của từng phòng, không nêu một con số chung ở đầu prompt:
    // mỗi phòng đăng lên số nhóm khác nhau nên cần số bài khác nhau.
    sections.push(
        item.variationCount === 1
            ? "Phòng này chỉ cần ĐÚNG 1 bài (mảng `variations` có đúng 1 phần tử)."
            : `Phòng này cần ĐÚNG ${item.variationCount} biến thể khác nhau.`,
    );

    return sections.join("\n\n");
}

/**
 * Prompt cho một lô phòng. Lô một phần tử vẫn đi đúng đường này — chỉ có câu mở đầu khác — để
 * không tồn tại hai đường sinh prompt phải giữ đồng bộ với nhau.
 */
export function buildComposerPrompt(items: ComposerItem[]): string {
    const header =
        items.length === 1
            ? "Hãy viết bài đăng cho phòng trọ dưới đây. Trả về mảng `items` gồm đúng 1 phần tử."
            : `Dưới đây là ${items.length} phòng ĐỘC LẬP, không liên quan gì tới nhau.\n` +
              "Số biến thể cần cho MỖI phòng được ghi ngay trong khối của phòng đó — làm đúng con " +
              "số ấy, KHÔNG viết thừa cho phòng chỉ cần ít.\n" +
              `Trả về mảng \`items\` gồm đúng ${items.length} phần tử, mỗi phần tử có \`index\` bằng ` +
              "số hiệu phòng tương ứng.";

    return [header, ...items.map((item, position) => buildListingBlock(item, position + 1))].join("\n\n");
}
