import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { env } from "../config/env.js";
import { BUSINESS_TIMEZONE } from "../config/constants.js";
import { randomInt } from "../utils/delay.js";
import { childLogger } from "../utils/logger.js";
import { detectCheckpoint } from "./checkpointDetector.js";
import { SUGGESTION_POPUP_SELECTOR, exists } from "./fbSelectors.js";

const log = childLogger("fb:browser");

let context: BrowserContext | null = null;

/**
 * Mở (hoặc dùng lại) trình duyệt gắn với hồ sơ cố định trên đĩa.
 *
 * Dùng persistent context thay vì tạo context mới mỗi lần: cookie, localStorage và
 * dấu vân tay thiết bị được giữ nguyên giữa các lần chạy. Đăng nhập lại liên tục
 * chính là hành vi bot dễ nhận ra nhất.
 */
export async function getBrowserContext(): Promise<BrowserContext> {
    if (context) return context;

    const profileDir = path.resolve(env.FB_BROWSER_PROFILE_DIR);

    context = await chromium.launchPersistentContext(profileDir, {
        // Chrome thật thay vì Chromium đóng gói kèm: dấu vân tay giống trình duyệt
        // người dùng bình thường hơn.
        channel: "chrome",
        headless: env.FB_HEADLESS,
        viewport: { width: 1366, height: 768 },
        locale: "vi-VN",
        // Múi giờ trình duyệt phải khớp với vị trí mà tài khoản tự nhận. VPS chạy UTC
        // trong khi tài khoản là người Việt Nam là một mâu thuẫn dễ bị soi.
        timezoneId: BUSINESS_TIMEZONE,
        // Bỏ cờ mặc định của Playwright (--enable-automation, --remote-debugging-pipe...)
        // vì chúng để lộ rõ đây là browser tự động hoá, khiến Facebook reload liên tục.
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
            "--disable-blink-features=AutomationControlled",
            "--disable-infobars",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-component-update",
        ],
    });

    context.setDefaultTimeout(env.FB_ACTION_TIMEOUT_MS);

    log.info({ profile: profileDir, headless: env.FB_HEADLESS }, "Đã mở trình duyệt");
    return context;
}

/**
 * Đóng trình duyệt đúng cách.
 *
 * Bắt buộc gọi khi tắt service: giết tiến trình đột ngột có thể làm hỏng hồ sơ
 * trình duyệt, mà hồ sơ hỏng đồng nghĩa phải đăng nhập Facebook lại bằng tay.
 */
export async function closeBrowser(): Promise<void> {
    if (!context) return;

    try {
        await context.close();
        log.info("Đã đóng trình duyệt");
    } catch (error) {
        log.warn({ err: error }, "Lỗi khi đóng trình duyệt");
    } finally {
        context = null;
    }
}

export async function newPage(): Promise<Page> {
    const browserContext = await getBrowserContext();
    const pages = browserContext.pages();
    // launchPersistentContext luôn mở sẵn một tab trống, tận dụng lại thay vì mở thêm.
    return pages.length > 0 ? (pages[0] as Page) : await browserContext.newPage();
}

export interface SessionStatus {
    loggedIn: boolean;
    reason: string;
}

/**
 * Kiểm tra phiên Facebook còn dùng được không.
 *
 * CỐ Ý không tự động điền tài khoản/mật khẩu: đăng nhập tự động là hành vi bị Facebook
 * soi kỹ nhất, và lưu mật khẩu trong .env để bot dùng là rủi ro không đáng đánh đổi.
 * Phiên hỏng thì dừng lại và nhờ người đăng nhập bằng tay.
 */
export async function checkSession(page: Page): Promise<SessionStatus> {
    await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded" });
    await humanPause();

    const checkpoint = await detectCheckpoint(page);
    if (checkpoint.detected) {
        return { loggedIn: false, reason: `Facebook chặn phiên (${checkpoint.kind}): ${checkpoint.evidence}` };
    }

    if (await exists(page, "loginForm", 3_000)) {
        return { loggedIn: false, reason: "Đang ở màn hình đăng nhập — phiên đã hết hạn" };
    }

    if (await exists(page, "loggedInMarker", 8_000)) {
        return { loggedIn: true, reason: "Phiên hợp lệ" };
    }

    return { loggedIn: false, reason: "Không nhận ra trạng thái đăng nhập (giao diện có thể đã đổi)" };
}

/** Khoảng nghỉ ngẫu nhiên giữa các thao tác, mô phỏng nhịp thao tác của người thật. */
export async function humanPause(minMs = env.HUMAN_DELAY_MIN_MS, maxMs = env.HUMAN_DELAY_MAX_MS): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, randomInt(minMs, maxMs)));
}

/**
 * Đóng bảng gợi ý tag người / gợi ý tìm kiếm nếu đang mở.
 *
 * Phải gọi trước mọi cú CLICK tiếp theo trong hộp soạn bài: bảng gợi ý nổi ngay cạnh con trỏ và có
 * thể phủ lên nút "Ảnh/video", nên một cú click tưởng là bấm nút lại rơi trúng một gợi ý và chèn
 * thẻ tag một người lạ vào bài.
 *
 * Escape đã được đo là an toàn (2026-08-24): nó chỉ đóng bảng gợi ý, số hộp thoại đang mở không đổi
 * và nội dung đang gõ giữ nguyên — KHÔNG đóng hộp soạn bài. Chỉ bấm khi thật sự thấy popup, để
 * không bao giờ gửi một phím Escape vu vơ vào hộp thoại.
 */
export async function dismissSuggestionPopup(page: Page): Promise<void> {
    const popup = page.locator(SUGGESTION_POPUP_SELECTOR).first();

    if (!(await popup.isVisible().catch(() => false))) return;

    await page.keyboard.press("Escape");
    await new Promise((resolve) => setTimeout(resolve, randomInt(200, 500)));

    if (await popup.isVisible().catch(() => false)) {
        log.warn("Bảng gợi ý tag người không chịu đóng sau khi bấm Escape");
    }
}

/**
 * Gõ chữ theo nhịp người thật.
 *
 * Dán nguyên cả bài (fill) là dấu hiệu bot rất rõ: người thật không thể điền
 * 1500 ký tự trong một lần. Gõ theo từng cụm, nghỉ lâu hơn ở chỗ xuống dòng —
 * giống lúc người ta ngừng để nghĩ.
 *
 * XUỐNG DÒNG BẰNG `insertText`, TUYỆT ĐỐI KHÔNG BẰNG PHÍM ENTER. Facebook bật bảng gợi ý tag người
 * ngay trong lúc gõ, và khi nó đang mở thì phím Enter/Shift+Enter được nó nuốt để CHỌN gợi ý đang
 * sáng thay vì xuống dòng. Ngày 2026-08-24 một bài kết thúc dòng đầu bằng "HOÀNG MAI" đã lên
 * Facebook thành "HOÀNG Mai Anh- Giá thuê..." — chữ MAI biến thành thẻ tag một người lạ tên Mai Anh
 * và dấu xuống dòng mất luôn. Tag bừa người không liên quan vừa làm hỏng nội dung, vừa là một trong
 * những dấu hiệu spam mà Facebook phạt nặng nhất.
 *
 * `insertText` chỉ phát sự kiện `input`, không phát keydown, nên bảng gợi ý về mặt cấu trúc KHÔNG
 * có gì để chặn — khác hẳn với việc dò xem popup có mở rồi mới bấm Enter, vốn vẫn thua nếu popup
 * kịp mở ngay sau lần dò. Đã đo thực tế: xuống dòng đúng, và popup đang mở tự đóng sau đó.
 */
export async function typeLikeHuman(page: Page, text: string): Promise<void> {
    const lines = text.split("\n");

    for (const [index, line] of lines.entries()) {
        if (line.length > 0) {
            await page.keyboard.type(line, { delay: randomInt(12, 45) });
        }

        if (index < lines.length - 1) {
            await page.keyboard.insertText("\n");
            await new Promise((resolve) => setTimeout(resolve, randomInt(120, 600)));
        }
    }

    // Dòng cuối thường kết thúc bằng hashtag hoặc tên người, nên popup rất hay còn mở ở đây —
    // đóng lại trước khi nơi gọi bấm bất cứ thứ gì.
    await dismissSuggestionPopup(page);
}
