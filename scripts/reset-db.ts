/**
 * Xoá sạch dữ liệu để chạy thử lại từ đầu. CHỈ dùng lúc phát triển.
 * Chạy: npm run reset-db
 *
 * Giữ nguyên phiên đăng nhập Zalo/Facebook — chỉ xoá dữ liệu nghiệp vụ và ảnh đã tải.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { COLLECTIONS } from "../src/config/constants.js";
import { env } from "../src/config/env.js";
import { connectMongo, closeMongo, getDb } from "../src/db/mongoClient.js";

/**
 * Các collection bị xoá khi reset.
 *
 * Lấy tên từ COLLECTIONS chứ không gõ tay chuỗi: trước đây script này gõ tay "appState" trong khi
 * tên thật là "app_state", nên document trạng thái không bao giờ được xoá — reset xong vẫn còn
 * cầu dao đã ngắt và bộ đếm bài hôm nay của lần chạy trước.
 */
const TARGETS = [
    COLLECTIONS.listings,
    COLLECTIONS.postJobs,
    COLLECTIONS.postHistory,
    COLLECTIONS.appState,
    COLLECTIONS.dailyMetrics,
] as const;

async function main() {
    console.log("Đang kết nối Database...");
    await connectMongo();
    const db = getDb();

    console.log("\nĐang xoá các collection...");
    for (const name of TARGETS) {
        try {
            await db.collection(name).drop();
            console.log(`  Đã xoá: ${name}`);
        } catch {
            // NamespaceNotFound — collection chưa từng được tạo, không phải lỗi.
            console.log(`  Bỏ qua (chưa tồn tại): ${name}`);
        }
    }

    console.log("\nĐang xoá ảnh đã tải...");
    try {
        const imageDir = path.resolve(env.ZALO_IMAGE_DIR);
        const files = await fs.readdir(imageDir);
        for (const file of files) {
            await fs.rm(path.join(imageDir, file), { recursive: true, force: true });
        }
        console.log(`  Đã xoá sạch ảnh trong: ${imageDir}`);
    } catch (error) {
        console.log("  Bỏ qua ảnh (thư mục chưa được tạo):", (error as Error).message);
    }

    console.log("\nHOÀN TẤT RESET.");
    console.log("Phiên đăng nhập Zalo/Facebook và các bản sao lưu vẫn được giữ nguyên.");
    console.log("Index sẽ được tạo lại tự động ở lần khởi động tới (npm run dev).");
    await closeMongo();
}

main().catch(async (error) => {
    console.error("Reset thất bại:", error);
    await closeMongo();
    process.exit(1);
});
