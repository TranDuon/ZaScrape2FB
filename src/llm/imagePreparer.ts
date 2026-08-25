import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import type { ListingImage } from "../models/listing.model.js";
import type { ImagePart } from "./geminiClient.js";

const log = childLogger("llm:images");

/**
 * Chuẩn bị ảnh để gửi kèm prompt.
 *
 * Hai bước tiết kiệm, đều cần thiết với dữ liệu thật:
 * 1. Chỉ lấy MAX_IMAGES_PER_EXTRACTION ảnh đầu — tin đăng thật thường có 10-15 ảnh,
 *    nhưng 3-4 ảnh đã đủ để model xác nhận loại phòng và nội thất. Toàn bộ ảnh vẫn
 *    được giữ nguyên trong DB để đăng lên Facebook.
 * 2. Thu nhỏ cạnh dài về EXTRACTION_IMAGE_MAX_DIMENSION — ảnh gốc từ điện thoại
 *    thường 3000px+, model chia ảnh thành các ô để đọc nên ảnh càng lớn càng tốn token.
 *
 * @param maxImages Ghi đè MAX_IMAGES_PER_EXTRACTION. Dùng khi gọi theo lô: cả lô chia nhau một
 *   trần ảnh chung nên mỗi tin được ít ảnh hơn bình thường.
 */
export async function prepareImagesForExtraction(images: ListingImage[], maxImages?: number): Promise<ImagePart[]> {
    const limit = maxImages ?? env.MAX_IMAGES_PER_EXTRACTION;
    if (limit <= 0) return [];

    const usable = images.filter((image) => image.storage === "local" && image.local_path).slice(0, limit);

    const parts: ImagePart[] = [];

    for (const image of usable) {
        const filePath = path.resolve(image.local_path as string);

        try {
            const resized = await sharp(filePath)
                .rotate() // tôn trọng EXIF, tránh ảnh bị xoay ngang khi model đọc
                .resize({
                    width: env.EXTRACTION_IMAGE_MAX_DIMENSION,
                    height: env.EXTRACTION_IMAGE_MAX_DIMENSION,
                    fit: "inside",
                    withoutEnlargement: true,
                })
                .jpeg({ quality: 80 })
                .toBuffer();

            parts.push({ mimeType: "image/jpeg", data: resized.toString("base64") });
        } catch (error) {
            // Ảnh hỏng/đã bị dọn dẹp không được làm hỏng cả lần trích xuất:
            // phần chữ vẫn đủ để tạo tin đăng.
            const reason = error instanceof Error ? error.message : String(error);
            const missing = await fs
                .access(filePath)
                .then(() => false)
                .catch(() => true);
            log.warn({ path: image.local_path, missing, reason }, "Bỏ qua ảnh không xử lý được");
        }
    }

    if (parts.length > 0) {
        log.debug({ sent: parts.length, available: images.length }, "Đã chuẩn bị ảnh cho Gemini");
    }

    return parts;
}
