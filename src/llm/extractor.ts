import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import type { ListingDoc, ListingParsedData } from "../models/listing.model.js";
import { generateJson } from "./geminiClient.js";
import { prepareImagesForExtraction } from "./imagePreparer.js";
import {
    BATCH_GEMINI_RESPONSE_SCHEMA,
    EXTRACTION_PROMPT_VERSION,
    batchExtractionSchema,
    type ExtractionResult,
} from "./extractor.schema.js";

const log = childLogger("llm:extractor");

const SYSTEM_INSTRUCTION = `Bạn là trợ lý bóc tách thông tin tin đăng cho thuê phòng trọ tại Việt Nam.
Đầu vào là tin nhắn thô từ nhóm Zalo môi giới nhà trọ, kèm ảnh phòng (nếu có).

QUY TẮC BẮT BUỘC:
- Chỉ trích xuất thông tin CÓ THẬT trong tin nhắn. Tuyệt đối không suy đoán, không bịa.
- Thiếu thông tin nào thì để null cho field đó, đừng cố đoán.
- Ảnh chỉ dùng để xác nhận loại phòng, nội thất, tiện ích — không dùng ảnh để đoán giá hay địa chỉ.

CÁCH ĐỌC CÁCH VIẾT TẮT CỦA NGƯỜI VIỆT:
- Tiền: "4tr5" = 4.500.000; "3tr2" = 3.200.000; "500k" = 500.000; "4tr" = 4.000.000; "2ty" = 2.000.000.000
- Điện nước: "4000/số" nghĩa là 4.000đ mỗi kWh; "35k/khối" là 35.000đ mỗi mét khối nước.
- Thời gian: "T8" = tháng 8; "30p" = 30 phút.
- Loại hình: "CCMN" = chung cư mini; "khép kín" = có nhà vệ sinh riêng trong phòng.

CẤU TRÚC TIN NHẮN THƯỜNG GẶP (nhận dạng theo các mục có tiêu đề, thường kèm emoji):
- "Nội thất:" -> điền vào furniture
- "Dịch vụ:" -> điền vào utilities (điện, nước, wifi, phí dịch vụ chung)
- "Lưu ý:" -> điền vào house_rules (cọc, thú cưng, số người/xe, khách nước ngoài, báo trước khi xem)

VỀ GIÁ DỊCH VỤ: giữ NGUYÊN VĂN chuỗi gốc kèm đơn vị (ví dụ "4000/kWh", "35k/khối", "250k/người/tháng").
Không quy đổi ra số, vì đơn vị mỗi nơi mỗi khác nên quy đổi rất dễ sai.
Riêng giá thuê (price_vnd), diện tích (area_m2) và tiền cọc (deposit_vnd) thì phải quy ra SỐ.

PHÂN LOẠI is_listing:
- true: tin rao một chỗ ở cụ thể để cho thuê hoặc bán.
- false: trò chuyện, hỏi đáp, cảm ơn, thông báo chính sách hoa hồng, quảng cáo dịch vụ,
  tuyển cộng tác viên, tin tìm phòng (người đi thuê hỏi), tin đăng gộp nhiều phòng khác nhau
  mà không tách bạch được.

confidence: cho điểm thấp khi tin nhắn mơ hồ, thiếu giá hoặc thiếu địa chỉ, hoặc khi
một tin nhắn chứa nhiều phòng khác nhau khiến việc gộp thành một tin đăng là sai lệch.

XỬ LÝ NHIỀU TIN TRONG MỘT LẦN:
Mỗi lần gửi có thể gồm nhiều tin nhắn ĐỘC LẬP, phân tách bằng dòng "=== TIN #n ===".
- Mỗi tin là một phòng riêng, của một người gửi riêng, KHÔNG liên quan gì tới nhau.
- TUYỆT ĐỐI không mượn thông tin của tin này để điền cho tin khác. Tin #2 thiếu giá thì để null,
  không được lấy giá của tin #1 hay #3.
- Ảnh nằm ngay sau tiêu đề của tin nào thì thuộc về tin đó.
- Trả về đúng một phần tử cho MỖI tin, kể cả tin không phải tin đăng phòng (is_listing=false).
- Chép đúng số hiệu n vào field "index" của phần tử tương ứng.`;

export interface ExtractionOutcome {
    result: ExtractionResult;
    parsedData: ListingParsedData;
    model: string;
    promptVersion: string;
    durationMs: number;
    /**
     * Token của CẢ LẦN GỌI, không phải của riêng tin này — một lần gọi phục vụ cả lô.
     * Luôn đọc kèm `batchSize`: cộng dồn `usage` qua từng tin sẽ đếm lô N tin thành N lần.
     */
    usage: { input_tokens: number | null; output_tokens: number | null };
    /** Số tin dùng chung lần gọi này. Chia `usage` cho nó mới ra chi phí thực của một tin. */
    batchSize: number;
    imagesSent: number;
}

/** Phần mô tả một tin trong prompt. Số hiệu `index` bắt đầu từ 1, khớp với field `index` trả về. */
function buildListingSection(listing: ListingDoc, index: number, imageCount: number): string {
    const text = listing.raw_message.text.trim();
    const sections: string[] = [];

    sections.push(`=== TIN #${index} ===`);
    sections.push(`Người gửi: ${listing.source.sender_name}`);

    if (text.length > 0) {
        sections.push(`Nội dung tin nhắn:\n"""\n${text}\n"""`);
    } else if (imageCount > 0) {
        sections.push(
            "Tin nhắn KHÔNG có phần chữ, chỉ có ảnh. Hãy trích xuất những gì đọc được từ ảnh " +
                "và để null cho mọi thông tin không nhìn thấy rõ. Đặt confidence thấp.",
        );
    } else {
        // Không chữ mà cũng không ảnh — xảy ra khi MAX_IMAGES_PER_EXTRACTION=0 (tắt gửi ảnh).
        // PHẢI nói thẳng là không có gì để đọc: nếu vẫn dùng câu "hãy trích xuất từ ảnh" ở nhánh
        // trên trong khi không đính kèm tấm nào, model được mời bịa ra dữ liệu — đúng thứ mà
        // system instruction cấm tuyệt đối.
        sections.push(
            "Tin nhắn này KHÔNG có phần chữ và KHÔNG có ảnh nào được gửi kèm. Không có gì để " +
                "bóc tách: đặt is_listing=false, confidence=0 và để null cho mọi field.",
        );
    }

    if (imageCount > 0) {
        const total = listing.images.length;
        const note =
            total > imageCount
                ? `Kèm ${imageCount} ảnh đầu tiên của TIN #${index} (tin này có tổng cộng ${total} ảnh).`
                : `Kèm ${imageCount} ảnh của TIN #${index}.`;
        sections.push(note);
    }

    return sections.join("\n\n");
}

/**
 * Số ảnh mỗi tin được mang theo khi đi chung một lô.
 *
 * Cả lô chia nhau trần EXTRACTION_BATCH_MAX_IMAGES, nếu không thì lô 5 tin × 4 ảnh thành 20 ảnh
 * trong một request — vừa nặng vừa dễ chạm giới hạn kích thước. Khi còn gửi ảnh thì luôn để lại
 * ít nhất 1 ảnh cho mỗi tin: ảnh là thứ duy nhất đọc được với tin chỉ có ảnh không có chữ.
 *
 * MAX_IMAGES_PER_EXTRACTION = 0 nghĩa là TẮT HẲN việc gửi ảnh cho Gemini, và phải trả về 0 thật.
 * Sàn `Math.max(1, …)` bên dưới từng nuốt mất ý định đó: `max(1, min(0, 3))` ra 1, nên đặt 0 vẫn
 * gửi một ảnh mỗi tin — mà ảnh chính là phần tốn token nhất của bước trích xuất.
 */
function imagesPerListing(batchSize: number): number {
    if (env.MAX_IMAGES_PER_EXTRACTION === 0) return 0;
    if (batchSize <= 1) return env.MAX_IMAGES_PER_EXTRACTION;

    const share = Math.floor(env.EXTRACTION_BATCH_MAX_IMAGES / batchSize);
    return Math.max(1, Math.min(env.MAX_IMAGES_PER_EXTRACTION, share));
}

/** Chuyển kết quả từ model về đúng hình dạng lưu trong MongoDB. */
function toParsedData(result: ExtractionResult): ListingParsedData {
    return {
        title: result.title,
        price_vnd: result.price_vnd,
        area_m2: result.area_m2,
        address: {
            raw: result.address.raw,
            ward: result.address.ward,
            district: result.address.district,
            city: result.address.city,
        },
        room_type: result.room_type,
        deposit_vnd: result.deposit_vnd,
        available_from: result.available_from,
        contact_phone: result.contact_phone,
        contact_name: result.contact_name,
        furniture: {
            summary: result.furniture.summary,
            items: result.furniture.items,
        },
        utilities: {
            electricity_price: result.utilities.electricity_price,
            water_price: result.utilities.water_price,
            wifi_price: result.utilities.wifi_price,
            service_fee: result.utilities.service_fee,
            service_fee_unit: result.utilities.service_fee_unit,
        },
        house_rules: {
            deposit_terms: result.house_rules.deposit_terms,
            pet_allowed: result.house_rules.pet_allowed,
            vehicle_limit: result.house_rules.vehicle_limit,
            foreigner_allowed: result.house_rules.foreigner_allowed,
            visit_notice_minutes: result.house_rules.visit_notice_minutes,
            other_rules: result.house_rules.other_rules,
        },
        amenities: result.amenities,
        notes: result.notes,
        extra: {},
    };
}

/**
 * Kết quả cho MỘT tin trong lô. Lỗi được cô lập theo từng tin: một tin model trả sai schema
 * không được phép làm hỏng các tin còn lại trong cùng lần gọi.
 */
export type ExtractionItemOutcome =
    | { ok: true; outcome: ExtractionOutcome }
    | { ok: false; error: Error };

/**
 * Trích xuất dữ liệu có cấu trúc cho NHIỀU listing trong MỘT lần gọi Gemini.
 *
 * Hai thứ được gộp chung một lần gọi, vì hai lý do khác nhau:
 * - Phân loại (is_listing) đi cùng bóc tách field: model đằng nào cũng phải đọc hết tin nhắn
 *   để làm một trong hai việc.
 * - Nhiều tin đi cùng một request: hạn ngạch miễn phí đếm theo SỐ LẦN GỌI mỗi ngày mỗi model,
 *   nên gom N tin làm cùng hạn ngạch đó xử lý được gấp N lần.
 *
 * Trả về mảng CÙNG ĐỘ DÀI và CÙNG THỨ TỰ với `batch` đầu vào. Ném lỗi chỉ khi cả lần gọi hỏng
 * (mạng, hết hạn ngạch, JSON không đọc được) — lúc đó nơi gọi cho cả lô thử lại.
 */
export async function extractListings(batch: ListingDoc[]): Promise<ExtractionItemOutcome[]> {
    if (batch.length === 0) return [];

    const imageLimit = imagesPerListing(batch.length);

    // Chữ và ảnh phải xen kẽ theo đúng thứ tự: ảnh của tin nào nằm ngay sau tiêu đề tin đó.
    // Gom hết chữ lên đầu rồi dồn ảnh xuống cuối là cách chắc chắn nhất để model gán nhầm ảnh.
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
    const imagesSentPerListing: number[] = [];

    for (const [position, listing] of batch.entries()) {
        const images = await prepareImagesForExtraction(listing.images, imageLimit);
        imagesSentPerListing.push(images.length);

        parts.push({ text: buildListingSection(listing, position + 1, images.length) });
        for (const image of images) {
            parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
        }
    }

    const header =
        batch.length === 1
            ? "Hãy bóc tách tin nhắn dưới đây và trả về mảng `items` gồm đúng 1 phần tử."
            : `Dưới đây là ${batch.length} tin nhắn ĐỘC LẬP, không liên quan gì tới nhau.\n` +
              `Hãy bóc tách TỪNG tin riêng biệt và trả về mảng \`items\` gồm đúng ${batch.length} phần tử, ` +
              "mỗi phần tử có `index` bằng số hiệu tin tương ứng.";

    const response = await generateJson({
        model: env.GEMINI_EXTRACTION_MODEL,
        systemInstruction: SYSTEM_INSTRUCTION,
        parts: [{ text: header }, ...parts],
        responseSchema: BATCH_GEMINI_RESPONSE_SCHEMA,
    });

    let payload: unknown;
    try {
        payload = JSON.parse(response.raw);
    } catch {
        // Structured output hiếm khi trả JSON hỏng, nhưng nếu có thì phải thấy được
        // nội dung thật để sửa prompt, chứ không chỉ biết "parse lỗi".
        log.error(
            { raw: response.raw.slice(0, 500), batch_size: batch.length, output_length: response.raw.length },
            "Gemini trả về JSON không hợp lệ — nếu tái diễn với lô lớn thì giảm EXTRACTION_BATCH_SIZE",
        );
        throw new Error("Gemini trả về JSON không hợp lệ");
    }

    const parsed = batchExtractionSchema.safeParse(payload);
    if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        log.error({ detail, raw: response.raw.slice(0, 500) }, "Kết quả Gemini không khớp schema");
        throw new Error(`Kết quả không khớp schema: ${detail}`);
    }

    // Ghép theo `index` chứ không theo vị trí trong mảng trả về: model đảo thứ tự thì kết quả
    // vẫn về đúng tin, thay vì gán lặng lẽ giá/địa chỉ của phòng này sang phòng khác.
    const byIndex = new Map<number, ExtractionResult & { index: number }>();
    for (const item of parsed.data.items) {
        if (item.index < 1 || item.index > batch.length) continue;
        if (byIndex.has(item.index)) continue; // trùng số hiệu: giữ bản đầu tiên
        byIndex.set(item.index, item);
    }

    const missing = batch.length - byIndex.size;
    if (missing > 0) {
        log.warn(
            { batch_size: batch.length, received: byIndex.size, returned: parsed.data.items.length },
            "Model bỏ sót tin trong lô — những tin thiếu sẽ được thử lại riêng",
        );
    }

    return batch.map((_, position) => {
        const item = byIndex.get(position + 1);

        if (!item) {
            return {
                ok: false as const,
                error: new Error(`Model không trả kết quả cho tin #${position + 1} trong lô ${batch.length} tin`),
            };
        }

        return {
            ok: true as const,
            outcome: {
                result: item,
                parsedData: toParsedData(item),
                model: env.GEMINI_EXTRACTION_MODEL,
                promptVersion: EXTRACTION_PROMPT_VERSION,
                durationMs: response.duration_ms,
                usage: response.usage,
                batchSize: batch.length,
                imagesSent: imagesSentPerListing[position] ?? 0,
            },
        };
    });
}

/**
 * Trích xuất một listing đơn lẻ — lô một phần tử, đi đúng đường code của lô nhiều phần tử.
 * Dùng cho script chạy tay (`test/extractor.manual.ts`) và cho lần thử lại của tin bị bỏ sót.
 */
export async function extractListing(listing: ListingDoc): Promise<ExtractionOutcome> {
    const [item] = await extractListings([listing]);

    if (!item) throw new Error("Gemini không trả về kết quả nào");
    if (!item.ok) throw item.error;

    return item.outcome;
}
