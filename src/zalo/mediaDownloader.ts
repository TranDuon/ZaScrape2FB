import fs from "node:fs/promises";
import path from "node:path";
import type { ObjectId } from "mongodb";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import type { ListingImage } from "../models/listing.model.js";

const log = childLogger("zalo:media");

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const EXTENSION_BY_MIME: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
};

function extensionFor(contentType: string | null, url: string): string {
    if (contentType) {
        const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
        const known = EXTENSION_BY_MIME[mime];
        if (known) return known;
    }
    const fromUrl = path.extname(new URL(url).pathname).toLowerCase();
    return fromUrl.length > 1 && fromUrl.length <= 5 ? fromUrl : ".jpg";
}

export interface PendingImage {
    url: string;
    thumb: string | null;
    messageId: string;
}

/**
 * Tải ảnh về đĩa. Không bao giờ ném lỗi ra ngoài: ảnh lỗi được ghi nhận trong
 * `download_error` và pipeline vẫn chạy tiếp — mất một ảnh không đáng để hỏng cả tin đăng.
 */
export async function downloadImages(pending: PendingImage[], batchKey: string): Promise<ListingImage[]> {
    if (pending.length === 0) return [];

    const targetDir = path.resolve(env.ZALO_IMAGE_DIR, batchKey);
    await fs.mkdir(targetDir, { recursive: true });

    const results: ListingImage[] = [];

    for (const [index, item] of pending.entries()) {
        const image: ListingImage = {
            original_url: item.url,
            local_path: null,
            storage: "none",
            message_id: item.messageId,
            bytes: null,
            downloaded_at: null,
            download_error: null,
        };

        try {
            const response = await fetch(item.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.byteLength === 0) throw new Error("File rỗng");
            if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error(`Ảnh quá lớn: ${buffer.byteLength} bytes`);

            const extension = extensionFor(response.headers.get("content-type"), item.url);
            const fileName = `${String(index + 1).padStart(2, "0")}-${item.messageId}${extension}`;
            const filePath = path.join(targetDir, fileName);
            await fs.writeFile(filePath, buffer);

            image.local_path = path.relative(process.cwd(), filePath).replaceAll("\\", "/");
            image.storage = "local";
            image.bytes = buffer.byteLength;
            image.downloaded_at = new Date();
        } catch (error) {
            image.download_error = error instanceof Error ? error.message : String(error);
            log.warn({ url: item.url, error: image.download_error }, "Tải ảnh thất bại");
        }

        results.push(image);
    }

    const succeeded = results.filter((image) => image.storage === "local").length;
    log.info({ total: pending.length, succeeded, dir: targetDir }, "Đã tải ảnh của batch");
    return results;
}

const INVALID_FOLDER_CHARS = /[\\/:*?"<>|]/g;
const FOLDER_NAME_MAX_LENGTH = 80;

/** Rút gọn địa chỉ thành tên thư mục hợp lệ trên cả Windows lẫn Linux. */
function sanitizeFolderName(raw: string): string {
    return raw.replaceAll(INVALID_FOLDER_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, FOLDER_NAME_MAX_LENGTH).trim();
}

/**
 * Đổi tên thư mục ảnh từ khoá tạm (thread+message đầu tiên, không đọc hiểu được) sang tên theo
 * địa chỉ, ngay khi trích xuất xong và biết địa chỉ thật — giúp dò dữ liệu trên đĩa bằng mắt
 * thường thay vì phải tra ngược ObjectId trong MongoDB. Luôn thêm hậu tố 6 ký tự cuối của
 * listingId để tránh đụng tên khi nhiều tin đăng cùng địa chỉ (nhà nhiều phòng đăng nhiều đợt).
 *
 * Không ném lỗi ra ngoài: đổi tên thất bại (ví dụ thư mục đang bị khoá) không đáng để hỏng cả
 * bước trích xuất — listing vẫn dùng được ảnh ở thư mục cũ.
 */
export async function relocateListingImages(
    images: ListingImage[],
    listingId: ObjectId,
    address: string | null,
): Promise<ListingImage[]> {
    const localImages = images.filter((image) => image.storage === "local" && image.local_path);
    if (localImages.length === 0 || !address) return images;

    const currentDir = path.dirname(path.resolve(localImages[0]!.local_path as string));
    const folderName = `${sanitizeFolderName(address) || "khong-ro-dia-chi"}-${listingId.toHexString().slice(-6)}`;
    const targetDir = path.resolve(env.ZALO_IMAGE_DIR, folderName);

    if (currentDir === targetDir) return images;

    try {
        await fs.rename(currentDir, targetDir);
    } catch (error) {
        log.warn({ from: currentDir, to: targetDir, err: error }, "Không đổi được tên thư mục ảnh theo địa chỉ, giữ nguyên tên cũ");
        return images;
    }

    log.info({ from: currentDir, to: targetDir }, "Đã đổi tên thư mục ảnh theo địa chỉ");

    return images.map((image) => {
        if (image.storage !== "local" || !image.local_path) return image;
        const fileName = path.basename(image.local_path);
        return {
            ...image,
            local_path: path.relative(process.cwd(), path.join(targetDir, fileName)).replaceAll("\\", "/"),
        };
    });
}
