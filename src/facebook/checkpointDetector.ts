import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("fb:checkpoint");

export type CheckpointKind = "checkpoint" | "captcha" | "logged_out" | "blocked" | "rate_limited";

export interface CheckpointResult {
    detected: boolean;
    kind: CheckpointKind | null;
    evidence: string | null;
}

/**
 * Đường dẫn URL cho biết Facebook đã chặn phiên làm việc.
 * Đây là tín hiệu chắc chắn nhất — chắc hơn nhiều so với dò chữ trong DOM.
 */
const URL_SIGNALS: Array<{ pattern: string; kind: CheckpointKind }> = [
    { pattern: "/checkpoint/", kind: "checkpoint" },
    { pattern: "/recover/", kind: "checkpoint" },
    { pattern: "/confirmemail", kind: "checkpoint" },
    { pattern: "/login/", kind: "logged_out" },
    { pattern: "/login.php", kind: "logged_out" },
    { pattern: "/disabled/", kind: "blocked" },
    { pattern: "/help/contact/", kind: "blocked" },
];

/**
 * Chữ hiển thị cho biết đang bị chặn. Liệt kê cả tiếng Việt lẫn tiếng Anh vì
 * giao diện đổi theo ngôn ngữ tài khoản.
 */
const TEXT_SIGNALS: Array<{ phrases: string[]; kind: CheckpointKind }> = [
    {
        kind: "checkpoint",
        phrases: [
            "xác nhận danh tính",
            "xác minh danh tính",
            "hãy xác nhận đây là bạn",
            "confirm your identity",
            "verify your identity",
            "please confirm it's you",
            "chúng tôi cần xác minh",
        ],
    },
    {
        kind: "captcha",
        phrases: ["nhập các ký tự", "security check", "kiểm tra bảo mật", "enter the characters", "recaptcha"],
    },
    {
        kind: "blocked",
        phrases: [
            "tài khoản của bạn đã bị khóa",
            "tạm thời bị chặn",
            "your account has been disabled",
            "you're temporarily blocked",
            "bạn đã bị chặn khỏi tính năng này",
            "vi phạm tiêu chuẩn cộng đồng",
        ],
    },
    {
        kind: "rate_limited",
        phrases: [
            "bạn đang thực hiện thao tác này quá nhanh",
            "you're doing that too much",
            "hãy thử lại sau",
            "slow down",
            "đã đăng quá nhiều",
        ],
    },
];

/**
 * Kiểm tra xem Facebook có đang chặn phiên hay không.
 *
 * Gọi hàm này sau MỌI thao tác quan trọng. Phát hiện sớm rồi dừng hẳn quan trọng hơn
 * việc cố hoàn thành bài đăng: thao tác tiếp trong lúc đang bị nghi ngờ chỉ khiến
 * Facebook chắc chắn hơn rằng đây là bot.
 */
export async function detectCheckpoint(page: Page): Promise<CheckpointResult> {
    const url = page.url();

    for (const signal of URL_SIGNALS) {
        if (url.includes(signal.pattern)) {
            return { detected: true, kind: signal.kind, evidence: `URL chứa "${signal.pattern}": ${url}` };
        }
    }

    let bodyText = "";
    try {
        // Chỉ lấy phần đầu: các cảnh báo chặn luôn nằm ở đầu trang, và đọc cả trang
        // của Facebook rất tốn thời gian.
        bodyText = ((await page.locator("body").innerText({ timeout: 5_000 })) ?? "").slice(0, 4_000).toLowerCase();
    } catch {
        // Trang đang chuyển hướng hoặc chưa dựng xong — không kết luận có checkpoint.
        return { detected: false, kind: null, evidence: null };
    }

    for (const signal of TEXT_SIGNALS) {
        const hit = signal.phrases.find((phrase) => bodyText.includes(phrase));
        if (hit) {
            return { detected: true, kind: signal.kind, evidence: `Trang hiển thị: "${hit}"` };
        }
    }

    return { detected: false, kind: null, evidence: null };
}

/**
 * Chụp màn hình làm bằng chứng.
 *
 * Bắt buộc khi chạy headless trên VPS: không nhìn được màn hình thật, ảnh chụp là
 * cách duy nhất để biết Facebook đã hiện cái gì lúc sự cố xảy ra.
 */
export async function captureScreenshot(page: Page, label: string): Promise<string | null> {
    try {
        await fs.mkdir(path.resolve(env.FB_SCREENSHOT_DIR), { recursive: true });

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filePath = path.resolve(env.FB_SCREENSHOT_DIR, `${stamp}-${label}.png`);
        await page.screenshot({ path: filePath, fullPage: false });

        const relative = path.relative(process.cwd(), filePath).replaceAll("\\", "/");
        log.info({ path: relative }, "Đã lưu ảnh chụp màn hình");
        return relative;
    } catch (error) {
        log.warn({ err: error }, "Không chụp được màn hình");
        return null;
    }
}
