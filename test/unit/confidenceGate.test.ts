import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/llm/confidenceGate.js";
import { extractionSchema, type ExtractionResult } from "../../src/llm/extractor.schema.js";
import type { ListingParsedData } from "../../src/models/listing.model.js";

const base: ExtractionResult = {
    is_listing: true,
    is_listing_reason: "Tin rao cho thuê phòng",
    confidence: 0.9,
    title: "Phòng đẹp",
    price_vnd: 4500000,
    area_m2: 25,
    address: { raw: "82 Chùa Láng, Đống Đa", ward: null, district: "Đống Đa", city: "Hà Nội" },
    room_type: "CCMN",
    deposit_vnd: null,
    available_from: null,
    contact_phone: "0987654321",
    contact_name: "Hằng",
    furniture: { summary: "full", items: [] },
    utilities: {
        electricity_price: "4000/kWh",
        water_price: "35k/khối",
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

function result(overrides: Partial<ExtractionResult>): ExtractionResult {
    return { ...base, ...overrides };
}

function parsed(overrides: Partial<ExtractionResult>): ListingParsedData {
    return { ...base, ...overrides, extra: {} };
}

describe("confidenceGate.evaluate", () => {
    it("đủ thông tin + tin cậy cao -> tự động đi tiếp (ready)", () => {
        expect(evaluate(base, parsed({})).status).toBe("ready");
    });

    it("không phải tin đăng -> ignored, không tốn chi phí về sau", () => {
        expect(evaluate(result({ is_listing: false }), parsed({})).status).toBe("ignored");
    });

    // Ràng buộc field đã được BỎ có chủ đích: tin Zalo thật hiếm khi đủ cả giá/địa chỉ/liên hệ,
    // giữ ràng buộc thì phần lớn tin thật bị chặn chờ duyệt tay. Vẫn ghi nhận field thiếu để soi lại.
    it("thiếu giá -> vẫn ready, nhưng ghi nhận field thiếu", () => {
        const decision = evaluate(result({ price_vnd: null }), parsed({ price_vnd: null }));
        expect(decision.status).toBe("ready");
        expect(decision.missingFields).toContain("price_vnd");
    });

    it("thiếu cả địa chỉ lẫn quận -> vẫn ready, ghi nhận field thiếu", () => {
        const decision = evaluate(base, parsed({ address: { raw: null, ward: null, district: null, city: "Hà Nội" } }));
        expect(decision.status).toBe("ready");
        expect(decision.missingFields).toContain("address");
    });

    // contact bị bỏ hẳn khỏi danh sách theo dõi: resolveContact() luôn ghi đè bằng
    // AGENT_CONTACT_PHONE nên field này bị vứt đi ở bước soạn bài, chặn vì nó là chặn nhầm.
    it("không có cách liên hệ -> ready, và KHÔNG coi contact là field thiếu", () => {
        const decision = evaluate(base, parsed({ contact_phone: null, contact_name: null }));
        expect(decision.status).toBe("ready");
        expect(decision.missingFields).not.toContain("contact");
    });

    it("thiếu hết mọi field nhưng vẫn là tin đăng + tin cậy cao -> ready", () => {
        const decision = evaluate(
            base,
            parsed({
                price_vnd: null,
                contact_phone: null,
                contact_name: null,
                address: { raw: null, ward: null, district: null, city: null },
            }),
        );
        expect(decision.status).toBe("ready");
        expect(decision.missingFields).toEqual(["price_vnd", "address"]);
    });

    it("độ tin cậy dưới ngưỡng -> needs_review", () => {
        expect(evaluate(result({ confidence: 0.4 }), parsed({})).status).toBe("needs_review");
    });

    it("không phải tin đăng thì bỏ qua luôn, không xét thiếu field (thứ tự kiểm tra quan trọng)", () => {
        const decision = evaluate(result({ is_listing: false, confidence: 0.1 }), parsed({ price_vnd: null }));
        expect(decision.status).toBe("ignored");
    });
});

describe("extractionSchema (chuẩn hoá dữ liệu bẩn từ model)", () => {
    // Structured output vẫn có thể trả thiếu field hoặc sai kiểu — zod phải chuẩn hoá được
    // thay vì làm hỏng cả lần trích xuất.
    const messy = extractionSchema.safeParse({
        is_listing: true,
        is_listing_reason: "  ",
        confidence: "0.85",
        price_vnd: "4.500.000",
        area_m2: 25,
        address: { raw: "  82 Chùa Láng  " },
        amenities: null,
        furniture: { items: null },
    });

    it("không văng lỗi với dữ liệu thiếu/sai kiểu", () => {
        expect(messy.success).toBe(true);
    });

    it("chuẩn hoá đúng từng field", () => {
        if (!messy.success) throw new Error("parse phải thành công");

        expect(messy.data.confidence).toBe(0.85);
        expect(messy.data.price_vnd).toBe(4500000);
        expect(messy.data.is_listing_reason).toBeNull();
        expect(messy.data.address.raw).toBe("82 Chùa Láng");
        expect(messy.data.amenities).toHaveLength(0);
        expect(messy.data.contact_phone).toBeNull();
    });
});
