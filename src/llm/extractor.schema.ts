import { Type, type Schema } from "@google/genai";
import { z } from "zod";
import { parseLooseNumber } from "./numberParser.js";

/**
 * Phiên bản prompt + schema. Tăng số này mỗi khi sửa prompt hoặc schema
 * để biết một listing cũ được trích xuất bằng logic nào (lưu ở extraction_meta).
 */
export const EXTRACTION_PROMPT_VERSION = "v1";

/**
 * Có HAI định nghĩa schema ở file này, cố ý:
 *
 * 1. `GEMINI_RESPONSE_SCHEMA` — hợp đồng gửi cho Gemini (structured output),
 *    dùng kiểu Schema riêng của Google.
 * 2. `extractionSchema` (zod) — kiểm tra lại dữ liệu Gemini trả về trước khi ghi DB.
 *
 * Không tin tưởng tuyệt đối vào structured output: model vẫn có thể trả thiếu field
 * hoặc sai kiểu. Zod là chốt chặn cuối cùng, đồng thời sinh ra kiểu TypeScript.
 * Hai định nghĩa đặt cạnh nhau để khi sửa một bên thì thấy ngay bên kia.
 */

const nullableString = (description: string): Schema => ({
    type: Type.STRING,
    nullable: true,
    description,
});

const nullableNumber = (description: string): Schema => ({
    type: Type.NUMBER,
    nullable: true,
    description,
});

const stringArray = (description: string): Schema => ({
    type: Type.ARRAY,
    description,
    items: { type: Type.STRING },
});

export const GEMINI_RESPONSE_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {
        is_listing: {
            type: Type.BOOLEAN,
            description:
                "true nếu đây là tin rao cho thuê/bán một chỗ ở cụ thể. " +
                "false với tin trò chuyện, hỏi đáp, thông báo chính sách, quảng cáo dịch vụ, tin tuyển dụng.",
        },
        is_listing_reason: {
            type: Type.STRING,
            description: "Giải thích ngắn gọn bằng tiếng Việt vì sao phân loại như vậy.",
        },
        confidence: {
            type: Type.NUMBER,
            description:
                "Độ tin cậy 0-1 vào việc trích xuất này chính xác. " +
                "Thấp khi tin nhắn mơ hồ, thiếu thông tin, hoặc gộp nhiều phòng khác nhau.",
        },
        title: nullableString("Tiêu đề ngắn gọn tự đặt cho tin đăng"),
        price_vnd: nullableNumber("Giá thuê mỗi tháng, quy đổi ra SỐ đồng. Ví dụ '4tr5' -> 4500000, '3,2 triệu' -> 3200000"),
        area_m2: nullableNumber("Diện tích tính bằng mét vuông"),
        address: {
            type: Type.OBJECT,
            properties: {
                raw: nullableString("Địa chỉ nguyên văn như trong tin nhắn"),
                ward: nullableString("Phường/xã"),
                district: nullableString("Quận/huyện"),
                city: nullableString("Tỉnh/thành phố"),
            },
            required: ["raw", "ward", "district", "city"],
        },
        room_type: nullableString("Loại hình: phòng trọ, chung cư mini, CCMN, studio, nhà nguyên căn, ở ghép..."),
        deposit_vnd: nullableNumber("Số tiền đặt cọc quy ra đồng, nếu nêu rõ bằng số tiền"),
        available_from: nullableString("Thời điểm có thể vào ở, giữ nguyên cách viết trong tin"),
        contact_phone: nullableString("Số điện thoại liên hệ"),
        contact_name: nullableString("Tên người liên hệ"),
        furniture: {
            type: Type.OBJECT,
            properties: {
                summary: nullableString("Tóm tắt mục nội thất, ví dụ 'full nội thất'"),
                items: stringArray("Từng món nội thất được liệt kê"),
            },
            required: ["summary", "items"],
        },
        utilities: {
            type: Type.OBJECT,
            description: "Giá dịch vụ. GIỮ NGUYÊN chuỗi gốc kèm đơn vị, KHÔNG quy đổi ra số.",
            properties: {
                electricity_price: nullableString("Giá điện, ví dụ '4000/kWh', '4k/số'"),
                water_price: nullableString("Giá nước, ví dụ '35k/khối', '100k/người'"),
                wifi_price: nullableString("Giá wifi, ví dụ '120k/tháng'"),
                service_fee: nullableString("Phí dịch vụ chung, ví dụ '250k/người/tháng'"),
                service_fee_unit: {
                    type: Type.STRING,
                    nullable: true,
                    enum: ["per_person", "flat"],
                    description: "per_person nếu phí tính theo đầu người, flat nếu tính theo phòng",
                },
            },
            required: ["electricity_price", "water_price", "wifi_price", "service_fee", "service_fee_unit"],
        },
        house_rules: {
            type: Type.OBJECT,
            description: "Nội dung mục 'Lưu ý' / quy định của chủ nhà",
            properties: {
                deposit_terms: nullableString("Điều khoản cọc, ví dụ 'thanh toán 1 cọc 1'"),
                pet_allowed: { type: Type.BOOLEAN, nullable: true, description: "Có cho nuôi thú cưng không" },
                vehicle_limit: nullableString("Giới hạn xe, ví dụ 'tối đa 3 người 2 xe', 'không nhận xe điện'"),
                foreigner_allowed: { type: Type.BOOLEAN, nullable: true, description: "Có nhận khách nước ngoài không" },
                visit_notice_minutes: nullableNumber("Số phút cần báo trước khi qua xem phòng"),
                other_rules: stringArray("Các quy định khác chưa thuộc mục nào ở trên"),
            },
            required: [
                "deposit_terms",
                "pet_allowed",
                "vehicle_limit",
                "foreigner_allowed",
                "visit_notice_minutes",
                "other_rules",
            ],
        },
        amenities: stringArray("Tiện ích: thang máy, ban công, gác lửng, khép kín, để xe miễn phí..."),
        notes: nullableString("Thông tin còn lại chưa thuộc field nào ở trên"),
    },
    required: [
        "is_listing",
        "is_listing_reason",
        "confidence",
        "title",
        "price_vnd",
        "area_m2",
        "address",
        "room_type",
        "deposit_vnd",
        "available_from",
        "contact_phone",
        "contact_name",
        "furniture",
        "utilities",
        "house_rules",
        "amenities",
        "notes",
    ],
};

/** Chuỗi rỗng/khoảng trắng từ model được quy về null để phần còn lại chỉ phải xử lý một dạng "không có". */
const looseString = z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
        const trimmed = typeof value === "string" ? value.trim() : "";
        return trimmed.length > 0 ? trimmed : null;
    });

const looseNumber = z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((value) => parseLooseNumber(value));

const looseBoolean = z
    .union([z.boolean(), z.null()])
    .optional()
    .transform((value) => (typeof value === "boolean" ? value : null));

const looseStringArray = z
    .union([z.array(z.string()), z.null()])
    .optional()
    .transform((value) => (Array.isArray(value) ? value.map((item) => item.trim()).filter(Boolean) : []));

export const extractionSchema = z.object({
    is_listing: z.boolean(),
    is_listing_reason: looseString,
    confidence: z.coerce.number().min(0).max(1).catch(0),
    title: looseString,
    price_vnd: looseNumber,
    area_m2: looseNumber,
    address: z
        .object({
            raw: looseString,
            ward: looseString,
            district: looseString,
            city: looseString,
        })
        .default({}),
    room_type: looseString,
    deposit_vnd: looseNumber,
    available_from: looseString,
    contact_phone: looseString,
    contact_name: looseString,
    furniture: z
        .object({
            summary: looseString,
            items: looseStringArray,
        })
        .default({}),
    utilities: z
        .object({
            electricity_price: looseString,
            water_price: looseString,
            wifi_price: looseString,
            service_fee: looseString,
            service_fee_unit: z
                .union([z.enum(["per_person", "flat"]), z.string(), z.null()])
                .optional()
                .transform((value) => (value === "per_person" || value === "flat" ? value : null)),
        })
        .default({}),
    house_rules: z
        .object({
            deposit_terms: looseString,
            pet_allowed: looseBoolean,
            vehicle_limit: looseString,
            foreigner_allowed: looseBoolean,
            visit_notice_minutes: looseNumber,
            other_rules: looseStringArray,
        })
        .default({}),
    amenities: looseStringArray,
    notes: looseString,
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

/**
 * Bản dùng cho lô nhiều tin trong MỘT lần gọi (tiết kiệm hạn ngạch — xem batchCollector.ts).
 *
 * `index` là thứ giữ cho kết quả không bị gán nhầm tin: model được yêu cầu chép lại số hiệu
 * "=== TIN #n ===" vào từng phần tử, nên nơi gọi ghép kết quả theo `index` chứ KHÔNG theo thứ tự
 * mảng trả về. Model đảo thứ tự hay bỏ sót một tin thì chỉ tin đó hỏng, các tin khác vẫn đúng —
 * còn nếu tin theo vị trí thì một lần đảo thứ tự sẽ gán giá/địa chỉ của phòng này sang phòng khác
 * mà không có cách nào phát hiện.
 */
export const BATCH_GEMINI_RESPONSE_SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {
        items: {
            type: Type.ARRAY,
            description: "Kết quả cho TỪNG tin nhắn, mỗi tin một phần tử, không gộp, không bỏ sót",
            items: {
                type: Type.OBJECT,
                properties: {
                    index: {
                        type: Type.INTEGER,
                        description: "Số hiệu tin, chép đúng con số trong tiêu đề '=== TIN #n ===' của tin đó",
                    },
                    ...GEMINI_RESPONSE_SCHEMA.properties,
                },
                required: ["index", ...(GEMINI_RESPONSE_SCHEMA.required ?? [])],
            },
        },
    },
    required: ["items"],
};

export const batchExtractionSchema = z.object({
    items: z.array(extractionSchema.extend({ index: z.coerce.number().int() })),
});
