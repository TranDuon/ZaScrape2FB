/**
 * Xem nhanh các tin đăng đã lưu trong MongoDB — không sửa gì, chỉ đọc.
 * Chạy: npm run check:listings
 */
import { connectMongo, closeMongo } from "../src/db/mongoClient.js";
import { listings } from "../src/db/collections.js";
import { logger } from "../src/utils/logger.js";

async function main(): Promise<void> {
    await connectMongo();

    const total = await listings().countDocuments();
    console.log(`\n=== Tổng số tin đăng đã lưu: ${total} ===\n`);

    if (total === 0) {
        console.log("Chưa có tin nào. Kiểm tra:");
        console.log("  1. Agent (npm run dev) có đang chạy không?");
        console.log("  2. Tin nhắn có được gửi vào đúng 1 trong 3 nhóm đã cấu hình không?");
        console.log("  3. Đã chờ đủ 45 giây im lặng sau tin nhắn cuối chưa (ZALO_BATCH_WINDOW_MS)?");
        await closeMongo();
        process.exit(0);
    }

    const recent = await listings().find().sort({ created_at: -1 }).limit(10).toArray();

    for (const doc of recent) {
        const imagesOk = doc.images.filter((img) => img.storage === "local").length;
        const imagesFail = doc.images.filter((img) => img.download_error).length;

        console.log("----------------------------------------");
        console.log("id:          ", doc._id?.toHexString());
        console.log("thread_id:   ", doc.source.thread_id);
        console.log("người gửi:   ", doc.source.sender_name, `(${doc.source.sender_id})`);
        console.log("nhận lúc:    ", doc.raw_message.received_at.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }));
        console.log("số tin gộp:  ", doc.source.message_ids.length);
        console.log("ảnh:         ", `${imagesOk} tải thành công` + (imagesFail > 0 ? `, ${imagesFail} lỗi` : ""));
        console.log("status:      ", doc.status);
        console.log("nội dung:");
        console.log(
            doc.raw_message.text
                .split("\n")
                .map((line) => "  " + line)
                .join("\n") || "  (không có chữ, chỉ có ảnh)",
        );
    }

    console.log("\n----------------------------------------");
    console.log(`Hiển thị ${recent.length}/${total} tin gần nhất.`);

    await closeMongo();
}

main().catch((error) => {
    logger.error({ err: error }, "Không đọc được danh sách tin đăng");
    process.exit(1);
});
