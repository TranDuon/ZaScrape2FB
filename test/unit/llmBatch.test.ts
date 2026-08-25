import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { ListingDoc } from "../../src/models/listing.model.js";

/**
 * Kiểm tra phần NGUY HIỂM NHẤT của việc gom lô: ghép kết quả về đúng tin.
 *
 * Gom N tin vào một lần gọi nghĩa là model trả về một mảng, và mảng đó có thể sai thứ tự, thiếu
 * phần tử, hoặc trùng số hiệu. Ghép theo VỊ TRÍ thì một lần đảo thứ tự sẽ gán giá/địa chỉ/số điện
 * thoại của phòng này sang phòng khác — sai lặng lẽ, không có lỗi nào bật ra, và hậu quả là bài
 * đăng lên Facebook mang thông tin lẫn lộn giữa hai phòng thật. Vì vậy code ghép theo `index` và
 * đây là test giữ cho điều đó không bị đổi ngược lại.
 *
 * generateJson được mock: mục tiêu là logic ghép, không phải chất lượng output của Gemini.
 */
const generateJsonMock = vi.fn();

vi.mock("../../src/llm/geminiClient.js", () => ({
    generateJson: generateJsonMock,
    isGeminiConfigured: () => true,
}));

// Ảnh không liên quan tới logic ghép, và tránh phải có file thật trên đĩa.
vi.mock("../../src/llm/imagePreparer.js", () => ({
    prepareImagesForExtraction: async () => [],
}));

const { extractListings } = await import("../../src/llm/extractor.js");
const { composePosts } = await import("../../src/llm/composer.js");

function listingWithText(text: string): ListingDoc {
    return {
        _id: new ObjectId(),
        source: {
            platform: "zalo",
            thread_id: "t1",
            thread_type: 1,
            sender_id: "s1",
            sender_name: "Người gửi",
            message_ids: [new ObjectId().toHexString()],
        },
        raw_message: { text, received_at: new Date() },
        images: [],
        is_listing: null,
        is_listing_reason: null,
        parsed_data: null,
        confidence_score: null,
        missing_required_fields: [],
        extraction_meta: { model: null, prompt_version: null, attempts: 0, last_error: null },
        composed_post: null,
        status: "received",
        status_history: [],
        review: { reviewed_at: null, action: null },
        target_group_ids: [],
        created_at: new Date(),
        updated_at: new Date(),
    };
}

/** Phần tử kết quả trích xuất tối thiểu, chỉ đủ field để phân biệt các tin với nhau. */
function extractionItem(index: number, address: string, price: number) {
    return {
        index,
        is_listing: true,
        is_listing_reason: "tin đăng phòng",
        confidence: 0.9,
        title: null,
        price_vnd: price,
        area_m2: null,
        address: { raw: address, ward: null, district: null, city: null },
        room_type: null,
        deposit_vnd: null,
        available_from: null,
        contact_phone: null,
        contact_name: null,
        furniture: { summary: null, items: [] },
        utilities: {
            electricity_price: null,
            water_price: null,
            wifi_price: null,
            service_fee: null,
            service_fee_unit: null,
        },
        house_rules: {
            deposit_terms: null,
            pet_allowed: null,
            vehicle_limit: null,
            foreigner_allowed: null,
            visit_notice_minutes: null,
            other_rules: [],
        },
        amenities: [],
        notes: null,
    };
}

function respondWith(payload: unknown): void {
    generateJsonMock.mockResolvedValue({
        raw: JSON.stringify(payload),
        usage: { input_tokens: 1, output_tokens: 1 },
        duration_ms: 10,
    });
}

describe("extractListings — ghép kết quả lô theo index", () => {
    beforeEach(() => {
        generateJsonMock.mockReset();
    });

    it("chỉ gọi Gemini MỘT lần cho cả lô", async () => {
        const batch = [listingWithText("tin 1"), listingWithText("tin 2"), listingWithText("tin 3")];
        respondWith({
            items: [extractionItem(1, "Số 1", 3_000_000), extractionItem(2, "Số 2", 4_000_000), extractionItem(3, "Số 3", 5_000_000)],
        });

        await extractListings(batch);

        expect(generateJsonMock).toHaveBeenCalledTimes(1);
    });

    it("gán đúng tin kể cả khi model trả về SAI THỨ TỰ", async () => {
        const batch = [listingWithText("tin 1"), listingWithText("tin 2"), listingWithText("tin 3")];
        // Model trả 3 -> 1 -> 2. Ghép theo vị trí sẽ gán "Số 3" cho tin 1.
        respondWith({
            items: [extractionItem(3, "Số 3", 5_000_000), extractionItem(1, "Số 1", 3_000_000), extractionItem(2, "Số 2", 4_000_000)],
        });

        const results = await extractListings(batch);

        expect(results.map((item) => (item.ok ? item.outcome.parsedData.address.raw : null))).toEqual([
            "Số 1",
            "Số 2",
            "Số 3",
        ]);
        expect(results.map((item) => (item.ok ? item.outcome.parsedData.price_vnd : null))).toEqual([
            3_000_000, 4_000_000, 5_000_000,
        ]);
    });

    it("model bỏ sót một tin: chỉ tin đó hỏng, các tin còn lại vẫn đúng", async () => {
        const batch = [listingWithText("tin 1"), listingWithText("tin 2"), listingWithText("tin 3")];
        respondWith({ items: [extractionItem(1, "Số 1", 3_000_000), extractionItem(3, "Số 3", 5_000_000)] });

        const results = await extractListings(batch);

        expect(results[0]?.ok).toBe(true);
        expect(results[1]?.ok).toBe(false);
        expect(results[2]?.ok).toBe(true);
        expect(results[2]?.ok === true && results[2].outcome.parsedData.address.raw).toBe("Số 3");
    });

    it("bỏ qua index nằm ngoài lô và index trùng, không để lệch các tin sau", async () => {
        const batch = [listingWithText("tin 1"), listingWithText("tin 2")];
        respondWith({
            items: [
                extractionItem(9, "Ngoài lô", 1_000_000),
                extractionItem(1, "Số 1", 3_000_000),
                extractionItem(1, "Số 1 lặp lại", 9_999_999),
                extractionItem(2, "Số 2", 4_000_000),
            ],
        });

        const results = await extractListings(batch);

        expect(results).toHaveLength(2);
        expect(results[0]?.ok === true && results[0].outcome.parsedData.address.raw).toBe("Số 1");
        expect(results[1]?.ok === true && results[1].outcome.parsedData.address.raw).toBe("Số 2");
    });

    it("lô rỗng thì không gọi Gemini", async () => {
        expect(await extractListings([])).toEqual([]);
        expect(generateJsonMock).not.toHaveBeenCalled();
    });
});

describe("composePosts — ghép bài viết lô theo index", () => {
    beforeEach(() => {
        generateJsonMock.mockReset();
    });

    function listingReadyToCompose(address: string, phone: string): ListingDoc {
        const listing = listingWithText("đã trích xuất");
        listing.parsed_data = {
            title: null,
            price_vnd: 3_000_000,
            area_m2: null,
            address: { raw: address, ward: null, district: null, city: null },
            room_type: null,
            deposit_vnd: null,
            available_from: null,
            contact_phone: phone,
            contact_name: null,
            furniture: { summary: null, items: [] },
            utilities: {
                electricity_price: null,
                water_price: null,
                wifi_price: null,
                service_fee: null,
                service_fee_unit: null,
            },
            house_rules: {
                deposit_terms: null,
                pet_allowed: null,
                vehicle_limit: null,
                foreigner_allowed: null,
                visit_notice_minutes: null,
                other_rules: [],
            },
            amenities: [],
            notes: null,
            extra: {},
        };
        return listing;
    }

    it("gán đúng phòng kể cả khi model trả về sai thứ tự", async () => {
        const batch = [listingReadyToCompose("Số 1", "0900000001"), listingReadyToCompose("Số 2", "0900000002")];
        respondWith({
            items: [
                { index: 2, variations: [{ text: "Bài của phòng 2", hashtags: ["#b"] }] },
                { index: 1, variations: [{ text: "Bài của phòng 1", hashtags: ["#a"] }] },
            ],
        });

        const results = await composePosts(batch, batch.map(() => 1));

        expect(results[0]?.ok === true && results[0].outcome.variations[0]?.text).toBe("Bài của phòng 1");
        expect(results[1]?.ok === true && results[1].outcome.variations[0]?.text).toBe("Bài của phòng 2");
        expect(generateJsonMock).toHaveBeenCalledTimes(1);
    });

    it("thiếu bài cho một phòng: chỉ phòng đó hỏng", async () => {
        const batch = [listingReadyToCompose("Số 1", "0900000001"), listingReadyToCompose("Số 2", "0900000002")];
        respondWith({ items: [{ index: 1, variations: [{ text: "Bài của phòng 1", hashtags: [] }] }] });

        const results = await composePosts(batch, batch.map(() => 1));

        expect(results[0]?.ok).toBe(true);
        expect(results[1]?.ok).toBe(false);
    });

    it("prompt chứa đủ số hiệu của mọi phòng trong lô", async () => {
        const batch = [
            listingReadyToCompose("Số 1", "0900000001"),
            listingReadyToCompose("Số 2", "0900000002"),
            listingReadyToCompose("Số 3", "0900000003"),
        ];
        respondWith({
            items: [1, 2, 3].map((index) => ({ index, variations: [{ text: `Bài ${index}`, hashtags: [] }] })),
        });

        await composePosts(batch, batch.map(() => 2));

        const prompt = generateJsonMock.mock.calls[0]?.[0]?.prompt as string;
        expect(prompt).toContain("=== PHÒNG #1 ===");
        expect(prompt).toContain("=== PHÒNG #2 ===");
        expect(prompt).toContain("=== PHÒNG #3 ===");
    });
});

/**
 * MAX_IMAGES_PER_EXTRACTION=0 là quyết định chi phí: ảnh từng chiếm ~80% input token của bước
 * trích xuất (~1.100 token mỗi ảnh 1024px) trong khi dữ liệu phòng nằm trong phần CHỮ.
 *
 * Test này gọi imagePreparer THẬT (không mock) vì cái bẫy nằm đúng ở đó: sàn `Math.max(1, …)`
 * trong `imagesPerListing` từng biến số 0 thành 1, nên đặt 0 vẫn gửi một ảnh mỗi tin — cả khoản
 * tiết kiệm coi như không tồn tại mà log không hề báo gì.
 */
describe("tắt ảnh khi trích xuất (MAX_IMAGES_PER_EXTRACTION=0)", () => {
    it("không chuẩn bị tấm ảnh nào dù listing có ảnh thật trên đĩa", async () => {
        vi.resetModules();
        const { prepareImagesForExtraction } = await import("../../src/llm/imagePreparer.js");
        const { env } = await import("../../src/config/env.js");

        const images = [
            { original_url: null, local_path: "data/images/khong-ton-tai/01.jpg", storage: "local" as const,
              message_id: "m1", bytes: 1, downloaded_at: new Date(), download_error: null },
            { original_url: null, local_path: "data/images/khong-ton-tai/02.jpg", storage: "local" as const,
              message_id: "m2", bytes: 1, downloaded_at: new Date(), download_error: null },
        ];

        expect(env.MAX_IMAGES_PER_EXTRACTION).toBe(0);
        // Trần 0 phải thắng, kể cả khi truyền thẳng 0 lẫn khi để hàm tự đọc env.
        expect(await prepareImagesForExtraction(images)).toHaveLength(0);
        expect(await prepareImagesForExtraction(images, 0)).toHaveLength(0);
    });
});
