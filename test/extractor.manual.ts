/**
 * Kiểm tra chất lượng trích xuất bằng Gemini với các tin nhắn mẫu.
 * Chạy: npm run test:extractor
 *
 * Gọi API thật nên tốn một ít quota. Không đụng tới MongoDB.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ObjectId } from "mongodb";
import { env } from "../src/config/env.js";
import { evaluate } from "../src/llm/confidenceGate.js";
import { extractListing } from "../src/llm/extractor.js";
import { isGeminiConfigured } from "../src/llm/geminiClient.js";
import type { ListingDoc } from "../src/models/listing.model.js";

interface Fixture {
    name: string;
    text: string;
    expect_is_listing: boolean;
    expect_status: string;
}

/** Dựng listing giả đúng hình dạng thật để đường đi của dữ liệu giống hệt lúc chạy production. */
function fakeListing(text: string): ListingDoc {
    const now = new Date();
    return {
        _id: new ObjectId(),
        source: {
            platform: "zalo",
            thread_id: "test-thread",
            thread_type: 1,
            sender_id: "test-sender",
            sender_name: "Người gửi thử",
            message_ids: ["test-msg"],
        },
        raw_message: { text, received_at: now },
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
        created_at: now,
        updated_at: now,
    };
}

function money(value: number | null): string {
    return value === null ? "null" : value.toLocaleString("vi-VN") + "đ";
}

async function main(): Promise<void> {
    if (!isGeminiConfigured()) {
        console.error("Thiếu GEMINI_API_KEY trong .env — không chạy được test này.");
        console.error("Lấy key tại: https://aistudio.google.com/apikey");
        process.exit(1);
    }

    const raw = await fs.readFile(path.resolve("test/fixtures/sample-messages.json"), "utf8");
    const fixtures = JSON.parse(raw) as Fixture[];

    console.log(`Model: ${env.GEMINI_EXTRACTION_MODEL}`);
    console.log(`Ngưỡng tin cậy: ${env.CONFIDENCE_THRESHOLD}\n`);

    let failed = 0;

    for (const [index, fixture] of fixtures.entries()) {
        console.log("=".repeat(70));
        console.log(`${index + 1}. ${fixture.name}`);

        const outcome = await extractListing(fakeListing(fixture.text));
        const decision = evaluate(outcome.result, outcome.parsedData);
        const data = outcome.parsedData;

        const listingOk = outcome.result.is_listing === fixture.expect_is_listing;
        const statusOk = decision.status === fixture.expect_status;
        if (!listingOk || !statusOk) failed++;

        console.log(`   is_listing:  ${outcome.result.is_listing} ${listingOk ? "(đúng)" : `(SAI, mong đợi ${fixture.expect_is_listing})`}`);
        console.log(`   confidence:  ${outcome.result.confidence.toFixed(2)}`);
        console.log(`   status:      ${decision.status} ${statusOk ? "(đúng)" : `(SAI, mong đợi ${fixture.expect_status})`}`);
        console.log(`   lý do:       ${decision.reason}`);

        if (outcome.result.is_listing) {
            console.log(`   giá:         ${money(data.price_vnd)}`);
            console.log(`   diện tích:   ${data.area_m2 ?? "null"} m2`);
            console.log(`   địa chỉ:     ${data.address.raw ?? "null"}`);
            console.log(`   quận:        ${data.address.district ?? "null"}`);
            console.log(`   liên hệ:     ${data.contact_name ?? "?"} / ${data.contact_phone ?? "?"}`);
            console.log(`   cọc:         ${money(data.deposit_vnd)}`);
            console.log(`   nội thất:    ${data.furniture.summary ?? "null"} | ${data.furniture.items.join(", ") || "-"}`);
            console.log(`   điện:        ${data.utilities.electricity_price ?? "null"}`);
            console.log(`   nước:        ${data.utilities.water_price ?? "null"}`);
            console.log(`   wifi:        ${data.utilities.wifi_price ?? "null"}`);
            console.log(`   phí dv:      ${data.utilities.service_fee ?? "null"} (${data.utilities.service_fee_unit ?? "-"})`);
            console.log(`   cọc (quy định): ${data.house_rules.deposit_terms ?? "null"}`);
            console.log(`   thú cưng:    ${data.house_rules.pet_allowed ?? "không rõ"}`);
            console.log(`   xe:          ${data.house_rules.vehicle_limit ?? "null"}`);
            console.log(`   người NN:    ${data.house_rules.foreigner_allowed ?? "không rõ"}`);
            console.log(`   báo trước:   ${data.house_rules.visit_notice_minutes ?? "null"} phút`);
            console.log(`   tiện ích:    ${data.amenities.join(", ") || "-"}`);
        }

        console.log(`   (${outcome.durationMs}ms, ${outcome.usage.input_tokens ?? "?"} token vào / ${outcome.usage.output_tokens ?? "?"} token ra)`);
    }

    console.log("=".repeat(70));
    console.log(failed === 0 ? `\nTẤT CẢ ${fixtures.length} TIN ĐỀU PHÂN LOẠI ĐÚNG` : `\n${failed}/${fixtures.length} tin phân loại SAI so với mong đợi`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error("Test thất bại:", error instanceof Error ? error.message : error);
    process.exit(1);
});
