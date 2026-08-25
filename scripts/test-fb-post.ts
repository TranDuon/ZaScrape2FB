
import { ObjectId } from "mongodb";
import { env } from "../src/config/env.js";
import { closeMongo, connectMongo } from "../src/db/mongoClient.js";
import { groups, listings } from "../src/db/collections.js";
import { captureScreenshot, detectCheckpoint } from "../src/facebook/checkpointDetector.js";
import { checkSession, closeBrowser, humanPause, newPage, typeLikeHuman } from "../src/facebook/fbBrowser.js";
import { SELECTORS, findOptional, findRequired } from "../src/facebook/fbSelectors.js";
import { attachImages, usableImagePaths, verifyComposedText } from "../src/facebook/fbPoster.js";
import { checkPostingAllowed } from "../src/facebook/rateLimiter.js";
import type { ListingImage } from "../src/models/listing.model.js";
import { logger } from "../src/utils/logger.js";

const DEFAULT_TEXT = `Đây là bài đăng thử của công cụ đăng tin.
Nếu bạn thấy bài này xuất hiện, hãy xoá giúp nhé.
Thời điểm: ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`;

function parseArgs(): { groupId: string | null; dryRun: boolean; text: string; listingId: string | null } {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");

    const textIndex = args.indexOf("--text");
    const text = textIndex >= 0 ? (args[textIndex + 1] ?? DEFAULT_TEXT) : DEFAULT_TEXT;

    const listingIndex = args.indexOf("--listing");
    const listingIdStr = listingIndex >= 0 ? args[listingIndex + 1] : null;
    const listingId = listingIdStr && ObjectId.isValid(listingIdStr) ? listingIdStr : null;

    const groupId = args.find((arg) => !arg.startsWith("--") && ObjectId.isValid(arg) && arg !== listingIdStr) ?? null;

    return { groupId, dryRun, text, listingId };
}

async function main(): Promise<void> {
    const { groupId, dryRun, text: defaultText, listingId } = parseArgs();

    await connectMongo();

    let text = defaultText;
    let images: ListingImage[] = [];

    if (listingId) {
        const listing = await listings().findOne({ _id: new ObjectId(listingId) });
        if (!listing) {
            console.error(`Không tìm thấy tin đăng với id ${listingId}`);
            await closeMongo();
            process.exit(1);
        }
        text = listing.composed_post?.text ?? listing.raw_message.text;
        images = listing.images || [];
    }

    if (!groupId) {
        const all = await groups().find().toArray();
        console.error("Cần chỉ định id group. Danh sách hiện có:\n");
        for (const group of all) {
            console.error(`  ${group._id?.toHexString()}  ${group.active ? "[BẬT]" : "[tắt]"}  ${group.name}`);
        }
        console.error("\nVí dụ: npm run test:fbpost -- <id> --dry-run");
        await closeMongo();
        process.exit(1);
    }

    const group = await groups().findOne({ _id: new ObjectId(groupId) });
    if (!group) {
        console.error(`Không tìm thấy group với id ${groupId}`);
        await closeMongo();
        process.exit(1);
    }

    console.log(`\n=== ${dryRun ? "CHẠY THỬ (KHÔNG ĐĂNG THẬT)" : "ĐĂNG BÀI THẬT"} ===`);
    console.log(`Nhóm: ${group.name}`);
    console.log(`URL:  ${group.url}`);
    console.log(`Chế độ hiển thị: ${env.FB_HEADLESS ? "ẩn (headless)" : "hiện cửa sổ"}\n`);

    if (!dryRun) {
        console.log("Bài sẽ ĐƯỢC ĐĂNG THẬT sau 5 giây. Nhấn Ctrl+C để huỷ...\n");
        await new Promise((resolve) => setTimeout(resolve, 5_000));
    }

    const gate = await checkPostingAllowed(group);
    console.log(`Kiểm tra hạn mức: ${gate.allowed ? "ĐẠT" : "CHẶN — " + gate.reason}`);
    if (!gate.allowed && !dryRun) {
        console.error("Bị chặn bởi bộ giới hạn, dừng lại. Dùng --dry-run để thử mà không bị chặn.");
        await closeMongo();
        process.exit(1);
    }

    const page = await newPage();

    console.log("\n[1/5] Kiểm tra phiên đăng nhập...");
    const session = await checkSession(page);
    console.log(`      ${session.loggedIn ? "OK" : "LỖI"} — ${session.reason}`);
    if (!session.loggedIn) {
        console.error("\nChạy: npm run login:facebook");
        await closeBrowser();
        await closeMongo();
        process.exit(1);
    }

    console.log("\n[2/5] Mở trang nhóm...");
    await page.goto(group.url, { waitUntil: "domcontentloaded", timeout: env.FB_ACTION_TIMEOUT_MS });
    await humanPause();

    const checkpoint = await detectCheckpoint(page);
    if (checkpoint.detected) {
        const shot = await captureScreenshot(page, "test-checkpoint");
        console.error(`      BỊ CHẶN (${checkpoint.kind}): ${checkpoint.evidence}`);
        console.error(`      Ảnh chụp: ${shot}`);
        await closeBrowser();
        await closeMongo();
        process.exit(1);
    }
    console.log("      OK — không thấy dấu hiệu bị chặn");

    console.log("\n[3/5] Tìm ô soạn bài...");
    const opener = await findRequired(page, "openComposer", 15_000);
    await opener.click();
    await humanPause();
    console.log("      OK — đã mở hộp thoại soạn bài");

    console.log("\n[4/5] Nhập nội dung...");
    const input = await findRequired(page, "composerInput", 15_000);
    await input.click();
    await humanPause(300, 1_000);
    await typeLikeHuman(page, text);
    console.log("      OK — đã nhập xong nội dung");

    // Gọi ĐÚNG hàm mà luồng thật dùng, không viết lại: bản sao logic ở đây từng khiến --dry-run
    // báo PASS trong khi luồng thật đăng bài không kèm ảnh nào.
    let imagesAttached = 0;
    if (images.length > 0) {
        console.log("\n[4.5/5] Tải ảnh lên...");
        const imagePaths = await usableImagePaths(images);

        if (imagePaths.length === 0) {
            console.log("      LỖI — Không có file ảnh nào tồn tại trên đĩa");
        } else {
            imagesAttached = await attachImages(page, imagePaths);
            if (imagesAttached > 0) {
                console.log(`      OK — đã đính kèm ${imagesAttached}/${imagePaths.length} ảnh (đã thấy ảnh xem trước)`);
                await humanPause(3_000, 6_000);
            } else {
                console.log(`      LỖI — không đính kèm được ảnh nào trong ${imagePaths.length} ảnh`);
                console.log("      Luồng thật sẽ BỎ DỞ ở đây chứ không đăng bài chỉ có chữ.");
            }
        }
    }

    // Cùng phép kiểm tra mà luồng thật dùng ngay trước nút Đăng. Bỏ qua ở đây thì --dry-run lại
    // báo mọi thứ ổn trong khi bài thật có thể dính thẻ tag người lạ.
    console.log("\n[4.8/5] Đối chiếu nội dung đã gõ...");
    try {
        await verifyComposedText(page, text);
        console.log("      OK — nội dung khớp bản đã duyệt, không có thẻ tag lạ");
    } catch (error) {
        console.log(`      LỖI — ${(error as Error).message}`);
        console.log("      Luồng thật sẽ BỎI DỞ ở đây chứ không đăng bài sai nội dung.");
    }

    console.log("\n[5/5] Tìm nút Đăng...");
    const submit = await findOptional(page, "submitButton", 10_000);
    console.log(`      ${submit ? "OK — đã tìm thấy nút Đăng" : "LỖI — không tìm thấy nút Đăng"}`);

    // Cuộn hộp soạn bài xuống cuối trước khi chụp: với bài dài, lưới ảnh nằm dưới phần chữ và bị
    // đẩy ra ngoài vùng nhìn, nên ảnh chụp "không thấy ảnh nào" dễ bị hiểu là nạp ảnh thất bại.
    if (imagesAttached > 0) {
        await page
            .locator(SELECTORS.imagePreview[0])
            .last()
            .scrollIntoViewIfNeeded()
            .catch(() => undefined);
        await humanPause(500, 1_000);
    }

    const shot = await captureScreenshot(page, dryRun ? "dry-run" : "truoc-khi-dang");
    console.log(`\nẢnh chụp màn hình: ${shot}`);

    if (dryRun) {
        console.log("\n=== CHẠY THỬ HOÀN TẤT — KHÔNG ĐĂNG GÌ CẢ ===");
        console.log("Mọi selector đều hoạt động. Bỏ --dry-run để đăng thật.");
        if (!env.FB_HEADLESS) {
            console.log("\nCửa sổ sẽ đóng sau 15 giây để bạn kịp nhìn...");
            await new Promise((resolve) => setTimeout(resolve, 15_000));
        }
    } else if (submit) {
        await submit.click();
        console.log("\nĐã bấm Đăng, chờ Facebook xử lý...");
        await humanPause(5_000, 8_000);

        const after = await detectCheckpoint(page);
        if (after.detected) {
            const errorShot = await captureScreenshot(page, "sau-khi-dang-bi-chan");
            console.error(`BỊ CHẶN sau khi đăng (${after.kind}): ${after.evidence}`);
            console.error(`Ảnh chụp: ${errorShot}`);
        } else {
            console.log("=== ĐÃ ĐĂNG — hãy tự mở nhóm kiểm tra bài có lên đúng không ===");
        }
    }

    await closeBrowser();
    await closeMongo();
    process.exit(0);
}

main().catch(async (error) => {
    logger.error({ err: error }, "Chạy thử thất bại");
    await closeBrowser();
    await closeMongo();
    process.exit(1);
});
