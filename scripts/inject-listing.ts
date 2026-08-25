/**
 * Tiêm một tin đăng vào pipeline như thể vừa nhận được từ Zalo — để test chủ động.
 *
 *   npm run inject -- --list           # xem các mẫu có sẵn
 *   npm run inject -- 0                # tiêm mẫu số 0
 *   npm run inject -- --text "..."     # tiêm nội dung tự viết
 *   npm run inject -- --text "..." --images "data/images/a.jpg,data/images/b.jpg"
 *   npm run inject -- --text-file /path/to/noi-dung.txt --images "a.jpg,b.jpg"
 *
 * VÌ SAO CẦN: `messageListener` bỏ qua tin do chính mình gửi (`message.isSelf`), nên không thể
 * tự nhắn vào nhóm Zalo để kích hoạt pipeline. Không có script này thì muốn test phải ngồi đợi
 * người khác đăng tin — không dùng được khi cần kiểm chứng ngay.
 *
 * Script chỉ thay thế đúng bước đầu (nhận tin từ Zalo). Toàn bộ phần sau chạy y hệt hàng thật:
 * trích xuất bằng Gemini -> confidence gate -> soạn bài -> xếp lịch -> đăng lên Facebook.
 * Agent (`npm run dev`) phải đang chạy thì tin mới được xử lý tiếp.
 *
 * `--images` trỏ tới file ẢNH ĐÃ CÓ SẴN trên đĩa (ví dụ ảnh thật đã tải từ một tin Zalo khác) —
 * script không tự tải ảnh mới, chỉ tham chiếu file đã tồn tại. Dùng khi muốn test bằng ảnh thật
 * thay vì tin không ảnh.
 *
 * Tin tiêm vào có `sender_name` là "TEST (tiêm tay)" để phân biệt với tin thật khi soi DB.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ObjectId } from "mongodb";
import { connectMongo, closeMongo } from "../src/db/mongoClient.js";
import { listings } from "../src/db/collections.js";
import { incrementDailyMetric } from "../src/db/indexes.js";
import { enqueueJob } from "../src/jobs/jobQueue.js";
import type { ListingDoc, ListingImage } from "../src/models/listing.model.js";

interface Fixture {
    name: string;
    text: string;
    expect_is_listing: boolean;
    expect_status: string;
}

/** Thread giả, khác hẳn id nhóm Zalo thật để lọc/xoá tin test về sau cho dễ. */
const TEST_THREAD_ID = "test-injected";

async function loadFixtures(): Promise<Fixture[]> {
    const raw = await fs.readFile("test/fixtures/sample-messages.json", "utf-8");
    return JSON.parse(raw) as Fixture[];
}

/** Tham chiếu tới ảnh ĐÃ CÓ trên đĩa — không tải gì mới, chỉ đo kích thước file để điền `bytes`. */
async function loadExistingImages(pathsArg: string, messageId: string): Promise<ListingImage[]> {
    const paths = pathsArg
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

    const images: ListingImage[] = [];

    for (const rawPath of paths) {
        const absolute = path.resolve(rawPath);
        const stat = await fs.stat(absolute).catch(() => null);

        if (!stat) {
            console.error(`Không tìm thấy file ảnh: ${rawPath} — bỏ qua.`);
            continue;
        }

        images.push({
            original_url: null,
            local_path: path.relative(process.cwd(), absolute).replaceAll("\\", "/"),
            storage: "local",
            message_id: messageId,
            bytes: stat.size,
            downloaded_at: stat.mtime,
            download_error: null,
        });
    }

    return images;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const fixtures = await loadFixtures();

    if (args.includes("--list") || args.length === 0) {
        console.log("\n=== Các mẫu tin có sẵn ===\n");
        fixtures.forEach((fixture, index) => {
            console.log(`  ${index}  [${fixture.expect_status.padEnd(12)}] ${fixture.name}`);
        });
        console.log("\nDùng: npm run inject -- <số>");
        console.log('Hoặc: npm run inject -- --text "nội dung tin đăng của bạn"');
        return;
    }

    const textIndex = args.indexOf("--text");
    const textFileIndex = args.indexOf("--text-file");
    let text: string;
    let label: string;

    if (textFileIndex >= 0) {
        // Đọc từ file thay vì đối số dòng lệnh: nội dung nhiều dòng truyền qua --text hay bị
        // shell cắt mất xuống dòng (mỗi dòng biến thành đối số riêng) tuỳ terminal/tool đang gọi.
        const filePath = args[textFileIndex + 1];
        if (!filePath) {
            console.error("Thiếu đường dẫn sau --text-file.");
            process.exit(1);
        }
        text = (await fs.readFile(filePath, "utf-8")).trim();
        label = `nội dung từ file ${filePath}`;
    } else if (textIndex >= 0) {
        text = args[textIndex + 1] ?? "";
        label = "nội dung tự viết";
        if (!text.trim()) {
            console.error('Thiếu nội dung sau --text. Ví dụ: npm run inject -- --text "Cho thuê phòng 25m2..."');
            process.exit(1);
        }
    } else {
        const index = Number(args[0]);
        const fixture = fixtures[index];
        if (!fixture) {
            console.error(`Không có mẫu số ${args[0]}. Chạy "npm run inject -- --list" để xem danh sách.`);
            process.exit(1);
        }
        text = fixture.text;
        label = fixture.name;
    }

    const imagesIndex = args.indexOf("--images");
    const imagesArg = imagesIndex >= 0 ? (args[imagesIndex + 1] ?? "") : "";

    await connectMongo();

    const now = new Date();
    // Message id gắn timestamp: index unique (thread_id + message_ids) sẽ chặn nếu trùng,
    // mà tiêm cùng một mẫu nhiều lần là chuyện bình thường khi đang test.
    const messageId = `test-${Date.now()}`;
    const images = imagesArg ? await loadExistingImages(imagesArg, messageId) : [];

    const listing: ListingDoc = {
        source: {
            platform: "zalo",
            thread_id: TEST_THREAD_ID,
            thread_type: 1,
            sender_id: "test-sender",
            sender_name: "TEST (tiêm tay)",
            message_ids: [messageId],
        },
        raw_message: { text, received_at: now },
        images, // Rỗng nếu không truyền --images: Gemini vẫn trích xuất được từ chữ, bài chỉ thiếu ảnh.
        is_listing: null,
        is_listing_reason: null,
        parsed_data: null,
        confidence_score: null,
        missing_required_fields: [],
        extraction_meta: { model: null, prompt_version: null, attempts: 0, last_error: null },
        composed_post: null,
        status: "received",
        status_history: [{ status: "received", at: now, note: "Tiêm tay để test" }],
        review: { reviewed_at: null, action: null },
        target_group_ids: [],
        created_at: now,
        updated_at: now,
    };

    const result = await listings().insertOne(listing);
    const listingId = result.insertedId as ObjectId;

    await incrementDailyMetric("listings_received");
    await enqueueJob({ type: "extract_listing", listingId });

    console.log(`\n=== ĐÃ TIÊM TIN VÀO PIPELINE ===`);
    console.log(`Mẫu:     ${label}`);
    console.log(`Mã tin:  ${listingId.toHexString().slice(-6)}   (dùng cho lệnh Telegram)`);
    console.log(`Id đầy đủ: ${listingId.toHexString()}`);
    console.log(`\nNội dung:\n${text.slice(0, 300)}${text.length > 300 ? "..." : ""}`);
    if (images.length > 0) console.log(`\nẢnh đính kèm: ${images.length} (${images.map((i) => i.local_path).join(", ")})`);
    console.log(`\nTheo dõi tiếp:`);
    console.log(`  - Agent phải đang chạy (npm run dev) thì tin mới được xử lý`);
    console.log(`  - npm run check:listings     xem trạng thái đi tới đâu`);
    console.log(`  - npm run check:stuck        xem có kẹt không`);

    await closeMongo();
}

main().catch(async (error) => {
    console.error("Tiêm tin thất bại:", error instanceof Error ? error.message : error);
    await closeMongo();
    process.exit(1);
});
