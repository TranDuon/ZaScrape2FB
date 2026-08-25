/**
 * Kiểm chứng Phase 5 đầu-cuối: soạn bài → tạo job đăng → soạn lại sau khi sửa.
 * Chạy: npm run test:composer
 *
 * Gọi Gemini thật và ghi vào MongoDB thật, nhưng dùng một listing giả lập riêng và
 * dọn sạch mọi thứ nó tạo ra khi kết thúc — không đụng tới dữ liệu thật.
 */
import { ObjectId } from "mongodb";
import { env } from "../src/config/env.js";
import { closeMongo, connectMongo } from "../src/db/mongoClient.js";
import { groups, listings, postJobs } from "../src/db/collections.js";
import { runComposerOnce } from "../src/jobs/composerWorker.js";
import { enqueueJob } from "../src/jobs/jobQueue.js";
import { isGeminiConfigured } from "../src/llm/geminiClient.js";
import { recomposeListing } from "../src/listings/recompose.js";
import type { ListingDoc } from "../src/models/listing.model.js";

let failed = 0;

function check(label: string, ok: boolean): void {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

/** Tin đăng mẫu đã bóc tách, mô phỏng đúng thứ extraction worker sinh ra. */
function sampleListing(): ListingDoc {
    const now = new Date();
    return {
        _id: new ObjectId(),
        source: {
            platform: "zalo",
            thread_id: "test-thread",
            thread_type: 1,
            sender_id: "test-sender",
            sender_name: "Người gửi thử",
            message_ids: [`test-${Date.now()}`],
        },
        raw_message: { text: "tin nhắn gốc dùng để test composer", received_at: now },
        images: [],
        is_listing: true,
        is_listing_reason: "Tin rao cho thuê phòng",
        parsed_data: {
            title: "CCMN full nội thất, thang máy",
            price_vnd: 6500000,
            area_m2: 30,
            address: { raw: "82 Chùa Láng, Đống Đa, Hà Nội", ward: null, district: "Đống Đa", city: "Hà Nội" },
            room_type: "chung cư mini",
            deposit_vnd: null,
            available_from: null,
            contact_phone: "0987654321",
            contact_name: "Thu Hằng",
            furniture: { summary: "full nội thất", items: ["điều hòa", "máy giặt chung", "giường", "tủ quần áo"] },
            utilities: {
                electricity_price: "4000/kWh",
                water_price: "35k/khối",
                wifi_price: "120k/tháng",
                service_fee: "250k/người/tháng",
                service_fee_unit: "per_person",
            },
            house_rules: {
                deposit_terms: "thanh toán 1 cọc 1",
                pet_allowed: true,
                vehicle_limit: "tối đa 3 người 2 xe, không nhận xe điện",
                foreigner_allowed: false,
                visit_notice_minutes: 30,
                other_rules: [],
            },
            amenities: ["thang máy", "ban công", "khép kín"],
            notes: null,
            extra: {},
        },
        confidence_score: 0.95,
        missing_required_fields: [],
        extraction_meta: { model: "test", prompt_version: "v1", attempts: 1, last_error: null },
        composed_post: null,
        status: "ready",
        status_history: [{ status: "ready", at: now, note: "dựng sẵn cho test" }],
        review: { reviewed_at: null, action: null },
        target_group_ids: [],
        created_at: now,
        updated_at: now,
    };
}

/** Đo mức khác biệt giữa 2 bài: tỉ lệ từ chung trên tổng số từ khác nhau (Jaccard). */
function similarity(a: string, b: string): number {
    const words = (text: string) => new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
    const setA = words(a);
    const setB = words(b);
    const shared = [...setA].filter((word) => setB.has(word)).length;
    const total = new Set([...setA, ...setB]).size;
    return total === 0 ? 0 : shared / total;
}

async function main(): Promise<void> {
    if (!isGeminiConfigured()) {
        console.error("Thiếu GEMINI_API_KEY trong .env");
        process.exit(1);
    }

    await connectMongo();

    const activeGroups = await groups().find({ active: true }).toArray();
    console.log(`Group đang bật: ${activeGroups.length}`);
    if (activeGroups.length === 0) {
        console.error('Chưa có group nào. Thêm bằng: npm run seed:groups -- add "Tên" "URL"');
        await closeMongo();
        process.exit(1);
    }

    const listing = sampleListing();
    const listingId = listing._id as ObjectId;
    console.log(`listing_id giả lập: ${listingId.toHexString()}\n`);

    try {
        await listings().insertOne(listing);
        await enqueueJob({ type: "compose_post", listingId });

        console.log("--- Soạn bài ---");
        const started = Date.now();
        const didWork = await runComposerOnce();
        check("Worker nhận và xử lý được job soạn bài", didWork);
        console.log(`(mất ${Date.now() - started}ms)\n`);

        const after = await listings().findOne({ _id: listingId });
        check('Listing chuyển sang trạng thái "queued"', after?.status === "queued");
        check("Đã lưu bản gốc vào composed_post", Boolean(after?.composed_post?.text));
        check("Đã ghi danh sách group đích", (after?.target_group_ids.length ?? 0) === activeGroups.length);

        const created = await postJobs()
            .find({ "payload.listing_id": listingId, type: "post_to_group" })
            .sort({ scheduled_at: 1 })
            .toArray();

        check(`Tạo đúng ${activeGroups.length} job đăng (thực tế ${created.length})`, created.length === activeGroups.length);
        check(
            "Mỗi job có snapshot nội dung riêng",
            created.length > 0 && created.every((job) => Boolean(job.payload.composed_text)),
        );

        const groupIds = new Set(created.map((job) => job.payload.group_id?.toHexString()));
        check("Mỗi group chỉ có đúng một job", created.length > 0 && groupIds.size === created.length);

        // Mốc thời gian phải tăng dần: đăng dồn dập nhiều group là dấu hiệu bot rõ nhất.
        const increasing = created.every(
            (job, index) => index === 0 || job.scheduled_at > (created[index - 1] as (typeof created)[number]).scheduled_at,
        );
        check("Lịch đăng giãn cách tăng dần giữa các group", created.length > 0 && increasing);

        console.log("\n--- Lịch đăng ---");
        for (const job of created) {
            const group = activeGroups.find((item) => item._id?.equals(job.payload.group_id as ObjectId));
            const at = job.scheduled_at.toLocaleString("vi-VN", { timeZone: env.TZ });
            const minutes = Math.round((job.scheduled_at.getTime() - Date.now()) / 60_000);
            console.log(`  ${at} (+${minutes}p)  ${group?.name?.slice(0, 45) ?? "?"}`);
        }

        console.log("\n--- Các biến thể nội dung ---");
        const texts = created.map((job) => job.payload.composed_text as string);
        for (const [index, text] of texts.entries()) {
            console.log(`\n${"=".repeat(64)}\nBIẾN THỂ ${index + 1}\n${"=".repeat(64)}`);
            console.log(text);
        }

        console.log("\n--- Mức khác biệt giữa các biến thể ---");
        let maxSimilarity = 0;
        for (let i = 0; i < texts.length; i++) {
            for (let j = i + 1; j < texts.length; j++) {
                const score = similarity(texts[i] as string, texts[j] as string);
                maxSimilarity = Math.max(maxSimilarity, score);
                console.log(`  biến thể ${i + 1} vs ${j + 1}: trùng ${(score * 100).toFixed(0)}% số từ`);
            }
        }

        check("Không có 2 biến thể nào giống hệt nhau", texts.length > 0 && new Set(texts).size === texts.length);
        // Cùng một phòng nên nhiều từ chung là bình thường; trùng quá cao mới là dấu hiệu
        // model chỉ đổi vài từ đồng nghĩa — đúng thứ Facebook coi là spam.
        check(
            `Khác biệt đủ rõ giữa các biến thể (trùng cao nhất ${(maxSimilarity * 100).toFixed(0)}%, ngưỡng 80%)`,
            texts.length > 1 && maxSimilarity < 0.8,
        );

        const contactOk = texts.every((text) => text.includes(env.AGENT_CONTACT_PHONE.trim() || "0987654321"));
        check("Mọi biến thể đều có số liên hệ", texts.length > 0 && contactOk);

        console.log("\n--- Soạn lại sau khi người dùng sửa nội dung ---");
        const result = await recomposeListing(listingId);
        check("Kích hoạt soạn lại thành công", result.ok);
        check(`Huỷ đúng ${created.length} job đang chờ`, result.pendingCancelled === created.length);
        console.log(`  Thông báo cho người dùng: "${result.message}"`);

        const reverted = await listings().findOne({ _id: listingId });
        check('Listing quay về trạng thái "ready"', reverted?.status === "ready");

        const cancelled = await postJobs().countDocuments({
            "payload.listing_id": listingId,
            type: "post_to_group",
            status: "cancelled",
        });
        check("Job đăng cũ được đánh dấu cancelled, không bị xoá mất dấu vết", cancelled === created.length);

        const pendingCompose = await postJobs().countDocuments({
            "payload.listing_id": listingId,
            type: "compose_post",
            status: "pending",
        });
        check("Đã xếp hàng job soạn bài mới", pendingCompose === 1);
    } finally {
        const deletedJobs = await postJobs().deleteMany({ "payload.listing_id": listingId });
        const deletedListing = await listings().deleteOne({ _id: listingId });
        console.log(`\nĐã dọn ${deletedJobs.deletedCount} job và ${deletedListing.deletedCount} listing test.`);
    }

    console.log(failed === 0 ? "\nTẤT CẢ ĐỀU ĐẠT" : `\n${failed} kiểm tra THẤT BẠI`);
    await closeMongo();
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
    console.error("Test thất bại:", error instanceof Error ? error.message : error);
    await closeMongo();
    process.exit(1);
});
