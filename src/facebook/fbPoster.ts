import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import type { ListingImage } from "../models/listing.model.js";
import { captureScreenshot, detectCheckpoint, type CheckpointKind } from "./checkpointDetector.js";
import { humanPause, typeLikeHuman } from "./fbBrowser.js";
import { SELECTORS, findOptional, findRequired } from "./fbSelectors.js";

const log = childLogger("fb:poster");

/** Facebook giới hạn số ảnh mỗi bài; giữ mức vừa phải cho nhanh và ít lỗi. */
const MAX_IMAGES_PER_POST = 10;

export class CheckpointError extends Error {
    constructor(
        public readonly kind: CheckpointKind,
        public readonly evidence: string,
        public readonly screenshotPath: string | null,
    ) {
        super(`Facebook chặn thao tác (${kind}): ${evidence}`);
        this.name = "CheckpointError";
    }
}

/**
 * Phòng có ảnh nhưng không đính kèm được ảnh nào.
 *
 * Ném TRƯỚC khi bấm Đăng, nên chắc chắn chưa có gì lên Facebook và job thử lại là an toàn.
 */
export class ImageAttachError extends Error {
    constructor(public readonly expected: number) {
        super(
            `Không đính kèm được ảnh nào (${expected} ảnh có sẵn trên đĩa) — đã bỏ dở, KHÔNG đăng bài. ` +
                `Nếu tái diễn, kiểm tra selector fileInput/photoButton/imagePreview trong src/facebook/fbSelectors.ts`,
        );
        this.name = "ImageAttachError";
    }
}

/**
 * Nội dung trong hộp soạn bài không khớp bản đã duyệt.
 *
 * Ném TRƯỚC khi bấm Đăng, nên chắc chắn chưa có gì lên Facebook và job thử lại là an toàn.
 */
export class ComposedTextMismatchError extends Error {
    constructor() {
        super(
            "Nội dung trong hộp soạn bài khác bản đã duyệt — đã bỏ dở, KHÔNG đăng bài. " +
                "Nguyên nhân hay gặp nhất: Facebook chèn thẻ tag một người lạ vào giữa bài.",
        );
        this.name = "ComposedTextMismatchError";
    }
}

export interface PostRequest {
    groupUrl: string;
    text: string;
    images: ListingImage[];
}

export interface PostOutcome {
    postUrl: string | null;
    imagesUploaded: number;
    durationMs: number;
}

/** Dừng ngay nếu Facebook đã chặn — thao tác tiếp chỉ làm nghi ngờ tăng lên. */
async function assertNotBlocked(page: Page, stage: string): Promise<void> {
    const result = await detectCheckpoint(page);
    if (!result.detected) return;

    const screenshot = await captureScreenshot(page, `checkpoint-${stage}`);
    throw new CheckpointError(result.kind as CheckpointKind, result.evidence ?? stage, screenshot);
}

/** Chỉ lấy các ảnh còn thật sự tồn tại trên đĩa — file có thể đã bị dọn dẹp. */
export async function usableImagePaths(images: ListingImage[]): Promise<string[]> {
    const paths: string[] = [];

    for (const image of images) {
        if (image.storage !== "local" || !image.local_path) continue;
        if (paths.length >= MAX_IMAGES_PER_POST) break;

        const absolute = path.resolve(image.local_path);
        try {
            await fs.access(absolute);
            paths.push(absolute);
        } catch {
            log.warn({ path: image.local_path }, "Ảnh không còn trên đĩa, bỏ qua");
        }
    }

    return paths;
}

/**
 * Chuẩn hoá trước khi so sánh nội dung đã gõ với bản đã duyệt.
 *
 * Cố ý bỏ qua khác biệt về khoảng trắng: trình soạn thảo của Facebook chèn ký tự rộng-0 để giữ con
 * trỏ và `innerText` luôn thêm một dòng trống ở cuối khối contenteditable. Bắt lỗi những thứ đó chỉ
 * tạo báo động giả rồi khiến người vận hành mất niềm tin vào phép kiểm tra này. Cái thật sự cần bắt
 * là KÝ TỰ bị đổi — đúng thứ xảy ra khi một thẻ tag người bị chèn vào.
 */
export function normalizeForCompare(text: string): string {
    return text
        .replace(/\r\n?/g, "\n")
        .replace(/[​-‍﻿]/g, "")
        // Mọi khoảng trắng KHÔNG phải xuống dòng (kể cả nbsp) quy về một dấu cách.
        .replace(/[^\S\n]+/g, " ")
        .split("\n")
        .map((line) => line.trim())
        .join("\n")
        .replace(/\n+$/, "");
}

/**
 * Đối chiếu nội dung thật trong hộp soạn bài với bản đã duyệt, ngay trước khi bấm Đăng.
 *
 * Tồn tại vì bản thân việc gõ chữ có thể bị Facebook can thiệp giữa chừng: bảng gợi ý tag người
 * từng nuốt phím xuống dòng và biến "HOÀNG MAI" thành thẻ tag "Mai Anh" (2026-08-24).
 * `typeLikeHuman` đã chặn đường đó bằng `insertText`, nhưng gõ xong không lỗi vẫn KHÔNG chứng minh
 * được nội dung đúng — chỉ có đọc ngược lại từ DOM mới chứng minh được.
 *
 * Đặt sát nút Đăng chứ không đặt ngay sau khi gõ: giữa hai mốc đó còn thao tác đính kèm ảnh, mà một
 * cú click trúng bảng gợi ý cũng chèn được thẻ tag. Kiểm ở mốc muộn nhất thì bao được cả hai.
 */
export async function verifyComposedText(page: Page, expected: string): Promise<void> {
    const editor = await findRequired(page, "composerInput", 5_000);
    const actual = await editor.innerText();

    if (normalizeForCompare(actual) === normalizeForCompare(expected)) return;

    const screenshot = await captureScreenshot(page, "sai-noi-dung");
    log.error(
        { screenshot, expected: expected.slice(0, 400), actual: actual.slice(0, 400) },
        "Nội dung trong hộp soạn bài khác bản đã duyệt — không đăng",
    );

    throw new ComposedTextMismatchError();
}

/**
 * Ảnh đã thật sự vào hộp soạn bài chưa, kèm số ảnh xem trước đếm được.
 *
 * Số đếm CHỈ để ghi log, không dùng để chặn: Facebook dựng thumbnail kiểu lazy nên với bộ 6 ảnh
 * thường chỉ có 5 thẻ img tồn tại cùng lúc. Chặn theo số đếm sẽ loại oan những bài hoàn toàn bình
 * thường. Ghi lại vẫn có giá trị vì trên VPS chạy headless thì log là bằng chứng duy nhất.
 */
async function checkPreview(page: Page, timeoutMs: number): Promise<{ ok: boolean; previews: number }> {
    const found = await findOptional(page, "imagePreview", timeoutMs);
    if (!found) return { ok: false, previews: 0 };

    // Selector đầu tiên của imagePreview là ảnh blob: — thứ đếm được và không phụ thuộc ngôn ngữ.
    const previews = await page.locator(SELECTORS.imagePreview[0]).count();
    return { ok: true, previews };
}

/**
 * Đính kèm ảnh vào hộp soạn bài. Trả về số ảnh đã nạp, 0 nghĩa là không nạp được.
 *
 * Đúng MỘT trong hai đường được chạy, không bao giờ cả hai — chạy cả hai thì bộ ảnh có thể bị nạp
 * hai lần và bài đăng ra nhân đôi số ảnh.
 *
 * 1. Bấm nút "Ảnh/video" rồi CHẶN hộp thoại chọn file của hệ điều hành. Đây là đường chính vì nó
 *    tác động vào đúng ô input mà Facebook tự mở, không phải ô ta đoán.
 * 2. Ghi thẳng vào ô input file trong DOM — chỉ dùng khi không thấy nút, hoặc bấm nút mà hộp chọn
 *    file không hiện ra.
 *
 * Đường 1 BẮT BUỘC đăng ký listener `filechooser` TRƯỚC khi bấm: Playwright chỉ chặn hộp thoại khi
 * đã có listener. Code cũ bấm nút trần, nên hộp thoại "Open" của Windows mở ra thật, đứng đó chặn
 * trang, không ai điền được — rồi bài vẫn được đăng ra không kèm ảnh nào.
 */
export async function attachImages(page: Page, imagePaths: string[]): Promise<number> {
    const photoButton = await findOptional(page, "photoButton", 5_000);
    let attached = false;

    if (photoButton) {
        // Đăng ký listener trước, chờ một nhịp cho Playwright kịp bật chặn hộp thoại qua CDP, rồi
        // mới bấm. Nhịp chờ vừa là hàng rào chống đua, vừa khớp nhịp bấm giống người thật.
        const chooserPromise = page.waitForEvent("filechooser", { timeout: 15_000 });
        await humanPause(400, 900);
        await photoButton.click();

        try {
            const chooser = await chooserPromise;
            await chooser.setFiles(imagePaths);
            attached = true;
        } catch (error) {
            log.warn({ err: error }, "Đã bấm nút Ảnh/video nhưng Facebook không mở hộp chọn file");
        }
    }

    if (!attached) {
        const fileInput = await findOptional(page, "fileInput", 5_000);
        if (!fileInput) {
            log.warn("Không thấy cả nút Ảnh/video lẫn ô input file trong hộp soạn bài");
            return 0;
        }

        log.warn("Dùng đường dự phòng: ghi trực tiếp vào ô input file");
        await fileInput.setInputFiles(imagePaths);
    }

    // Ảnh xem trước là bằng chứng duy nhất đáng tin. Chờ thoáng tay vì Facebook phải đọc file và
    // dựng thumbnail; hết thời gian mà không thấy thì coi như nạp thất bại.
    const preview = await checkPreview(page, 20_000);

    if (!preview.ok) {
        const screenshot = await captureScreenshot(page, "anh-khong-nap-duoc");
        log.warn({ screenshot }, "Không thấy ảnh xem trước trong hộp soạn bài");
        return 0;
    }

    log.debug({ sent: imagePaths.length, previews: preview.previews }, "Hộp soạn bài đã có ảnh xem trước");
    return imagePaths.length;
}

/**
 * Đăng một bài lên nhóm Facebook.
 *
 * Sau mỗi bước quan trọng đều kiểm tra checkpoint. Thà bỏ dở một bài còn hơn tiếp tục
 * thao tác trong lúc Facebook đang nghi ngờ tài khoản.
 */
export async function postToGroup(page: Page, request: PostRequest): Promise<PostOutcome> {
    const startedAt = Date.now();

    log.info({ url: request.groupUrl }, "Mở trang nhóm");
    await page.goto(request.groupUrl, { waitUntil: "domcontentloaded", timeout: env.FB_ACTION_TIMEOUT_MS });
    await humanPause();
    await assertNotBlocked(page, "mo-trang-nhom");

    // Người thật không bấm soạn bài ngay khi trang vừa hiện — luôn lướt xem trước.
    await page.mouse.wheel(0, 300 + Math.floor(Math.random() * 500));
    await humanPause();

    const opener = await findRequired(page, "openComposer", 15_000);
    await opener.click();
    await humanPause();
    await assertNotBlocked(page, "mo-hop-soan-bai");

    const input = await findRequired(page, "composerInput", 15_000);
    await input.click();
    await humanPause(300, 1_200);

    await typeLikeHuman(page, request.text);
    await humanPause();
    await assertNotBlocked(page, "nhap-noi-dung");

    const imagePaths = await usableImagePaths(request.images);
    let imagesUploaded = 0;

    if (imagePaths.length > 0) {
        imagesUploaded = await attachImages(page, imagePaths);

        if (imagesUploaded === 0) {
            // KHÔNG hạ cấp thành bài chỉ có chữ. Mỗi ngày chỉ có ~15 suất đăng, và tin phòng trọ
            // không ảnh gần như không ai liên hệ — tiêu một suất cho bài như vậy còn tệ hơn là bỏ
            // dở để job thử lại. Ném lỗi ở đây là trước khi bấm Đăng nên chưa có gì lên Facebook.
            throw new ImageAttachError(imagePaths.length);
        }

        log.info({ count: imagesUploaded }, "Đã nạp ảnh, chờ Facebook tải lên");
        // Ảnh cần thời gian tải lên; bấm Đăng quá sớm sẽ ra bài thiếu ảnh.
        await humanPause(3_000, 6_000);
        await assertNotBlocked(page, "tai-anh");
    }

    // Cửa cuối trước khi nội dung ra công khai: mọi thứ từ đây trở đi không thu hồi được.
    await verifyComposedText(page, request.text);

    const submit = await findRequired(page, "submitButton", 10_000);
    await humanPause();
    await submit.click();

    log.info("Đã bấm đăng, chờ Facebook xử lý");
    await humanPause(4_000, 8_000);
    await assertNotBlocked(page, "sau-khi-dang");

    return {
        // Facebook không hiển thị link bài vừa đăng ở chỗ nào ổn định để lấy tự động;
        // để null còn hơn bịa ra một đường dẫn có thể sai.
        postUrl: null,
        imagesUploaded,
        durationMs: Date.now() - startedAt,
    };
}
