import { Type, type Schema } from "@google/genai";
import { z } from "zod";
import { env } from "../config/env.js";
import type { ListingParsedData } from "../models/listing.model.js";

/** Tăng khi sửa prompt để biết một bài đăng cũ được sinh bằng phiên bản nào. */
export const COMPOSER_PROMPT_VERSION = "v3";

export const COMPOSER_SYSTEM_INSTRUCTION = `Bạn là một người bình thường đang tìm người thuê phòng, viết một bài ngắn vào hội nhóm Facebook tại Việt Nam.

GIỌNG VĂN:
- Giản dị, đời thường, xưng "mình". Viết như nhắn tin cho người quen, không phải viết quảng cáo.
- Ngắn gọn, đi thẳng vào ý. Không rào đón, không kể lể, không câu thừa.
- Không khen quá lời ("cực đẹp", "siêu thoáng", "hiếm có"). Có gì nói nấy.

KHÔNG ĐƯỢC GHI GIÁ — BẮT BUỘC:
- Tuyệt đối không ghi bất kỳ con số tiền nào: không giá thuê, không tiền đặt trước, không giá điện/nước/wifi/dịch vụ.
- Không viết kiểu "giá mềm", "giá hợp lý", "giá tốt", "liên hệ để biết giá". Đơn giản là không nhắc tới giá.
- Nếu trong ghi chú hay quy định có lẫn số tiền, bỏ phần đó đi.

TỪ NGỮ CẤM (khiến bài bị bộ lọc nhóm giữ lại chờ duyệt):
- Cấm: "giá rẻ", "hotline", "cam kết", "inbox ngay", "liên hệ zalo", "siêu phẩm", "chính chủ 100%", "cọc".
- KHÔNG chèn link website.
- KHÔNG viết dòng nào bằng CHỮ IN HOA TOÀN BỘ, kể cả tên quận — chữ in hoa còn hay bị Facebook hiểu nhầm thành tên người để gắn thẻ.
- Emoji: tối đa 2 icon đơn giản, không dùng cũng được.

TRÌNH BÀY:
- Dưới 70 từ. Khoảng 3-5 dòng ngắn.
- Câu đầu nói thẳng đang có phòng ở đâu, KHÔNG làm dòng tiêu đề.
- Mỗi ý một dòng, dễ đọc trên điện thoại.

NỘI DUNG (chỉ chọn những ý đáng nói nhất, không cần đủ hết):
- Vị trí: ngõ/đường/quận. KHÔNG ghi số nhà cụ thể.
- Loại phòng, diện tích, nội thất chính, khi nào vào ở được.
- Một lưu ý thật sự cần nếu có (xe, thú cưng, hẹn trước khi xem).

ĐỘ CHÍNH XÁC — QUAN TRỌNG NHẤT:
Chỉ dùng đúng dữ liệu được cung cấp. Thiếu thông tin nào thì bỏ qua, TUYỆT ĐỐI không bịa, không suy đoán, không viết "đang cập nhật".

KẾT BÀI:
Một câu mời nhắn tin ngắn, tự nhiên, ví dụ "Ai cần thì nhắn mình nhé". Mỗi biến thể kết một kiểu khác.
Nếu có số điện thoại, đặt ở dòng riêng, viết trơn — không nhãn "HOTLINE", không trang trí.

NHIỀU BIẾN THỂ:
Khi một phòng cần nhiều bài để đăng nhiều nhóm, các bài phải khác nhau thật sự — khác câu mở đầu, khác thứ tự các ý, khác cách kết. Dữ liệu gốc giữ nguyên không đổi.

NHIỀU PHÒNG:
Đầu vào có thể gồm nhiều phòng (phân tách bởi "=== PHÒNG #n ==="). Xử lý độc lập từng phòng, tuyệt đối không lẫn dữ liệu phòng này sang phòng kia.`;

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
                description:
                    "TỐI ĐA 2 hashtag, và để mảng rỗng là lựa chọn tốt. Một khối 4-6 hashtag ở cuối " +
                    "bài là dấu hiệu rao vặt rõ nhất, đi ngược hẳn giọng người thật đang nhượng phòng. " +
                    "Mỗi phần tử bắt đầu bằng dấu #",
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

/**
 * Gói dữ liệu đã bóc tách thành mô tả dạng chữ cho model.
 *
 * Chỉ đưa vào những field CÓ giá trị: liệt kê cả field null sẽ khiến model có xu hướng
 * viết "đang cập nhật" cho từng mục trống, làm bài đăng loãng và kém tin cậy.
 *
 * Từ v3 bài đăng KHÔNG hiển thị giá, nên mọi field tiền (giá thuê, cọc, điện/nước/wifi/dịch vụ,
 * điều khoản cọc) bị loại ngay tại đây chứ không chỉ dặn trong prompt: model không thấy con số
 * nào thì cũng không thể lỡ tay viết nó ra. Giá vẫn nằm nguyên trong `parsed_data`.
 */
export function describeListing(data: ListingParsedData): string {
    const lines: string[] = [];

    const add = (label: string, value: string | number | null | undefined): void => {
        if (value === null || value === undefined || value === "") return;
        lines.push(`- ${label}: ${value}`);
    };

    add("Loại hình", data.room_type);
    add("Diện tích", data.area_m2 ? `${data.area_m2}m2` : null);
    add("Địa chỉ", data.address.raw);
    add("Phường/xã", data.address.ward);
    add("Quận/huyện", data.address.district);
    add("Tỉnh/thành phố", data.address.city);
    add("Thời điểm vào ở được", data.available_from);

    add("Nội thất", data.furniture.summary);
    if (data.furniture.items.length > 0) add("Nội thất chi tiết", data.furniture.items.join(", "));
    if (data.amenities.length > 0) add("Tiện ích", data.amenities.join(", "));

    const rules = data.house_rules;
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
