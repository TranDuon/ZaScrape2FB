import type { Locator, Page } from "playwright";
import { childLogger } from "../utils/logger.js";

const log = childLogger("fb:selectors");

/**
 * Toàn bộ selector của Facebook gom về một chỗ.
 *
 * Facebook đổi cấu trúc DOM liên tục (class name được sinh tự động và đổi theo từng lần
 * build), nên KHÔNG bao giờ bám vào class. Mỗi phần tử có nhiều selector dự phòng, xếp
 * theo thứ tự bền vững giảm dần:
 *   1. aria-label / role — Facebook giữ khá ổn định vì phục vụ trợ năng
 *   2. Chữ hiển thị — đổi khi người dùng đổi ngôn ngữ, nên liệt kê cả tiếng Việt lẫn tiếng Anh
 *   3. Cấu trúc DOM — dễ gãy nhất, chỉ dùng làm phương án cuối
 *
 * Khi Facebook đổi giao diện, đây là file duy nhất cần sửa.
 */
export const SELECTORS = {
    /** Ô "Bạn viết gì đi..." trên trang nhóm — bấm vào để mở hộp thoại soạn bài. */
    openComposer: [
        '[role="button"]:has-text("Bạn viết gì đi")',
        '[role="button"]:has-text("Viết gì đó")',
        '[role="button"]:has-text("Write something")',
        '[role="button"]:has-text("Create a public post")',
        'div[role="button"][tabindex="0"]:has-text("Bạn viết")',
    ],

    /** Vùng nhập nội dung trong hộp thoại soạn bài. */
    composerInput: [
        'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
        'div[role="dialog"] div[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
        '[aria-label*="Bạn viết gì"][contenteditable="true"]',
    ],

    /** Nút mở phần đính kèm ảnh (nếu ô input file chưa sẵn có trong DOM). */
    photoButton: [
        'div[role="dialog"] [aria-label="Ảnh/video"]',
        'div[role="dialog"] [aria-label="Photo/video"]',
        'div[role="dialog"] [role="button"]:has-text("Ảnh/video")',
    ],

    /**
     * Ô input file thật để nạp ảnh.
     *
     * KHÔNG bám vào `accept*="image"`: Facebook liệt kê đuôi file cụ thể
     * (`.tiff,.jfif,.pjp,.apng,...`) chứ không phải kiểu MIME, nên chuỗi "image" có thể không hề
     * xuất hiện trong thuộc tính. Xếp từ hẹp tới rộng, phương án cuối là mọi input file trong hộp
     * soạn bài — chấp nhận được vì sau khi nạp còn bước kiểm tra ảnh xem trước.
     */
    fileInput: [
        'div[role="dialog"] input[type="file"][accept*="image"]',
        'div[role="dialog"] input[type="file"][accept*="jpeg"]',
        'div[role="dialog"] input[type="file"][accept*="jpg"]',
        'div[role="dialog"] input[type="file"]',
        'input[type="file"][accept*="image"]',
    ],

    /**
     * Bằng chứng ảnh ĐÃ vào hộp soạn bài.
     *
     * Bắt buộc phải kiểm tra: `setInputFiles` không ném lỗi khi ghi vào một ô input không phải ô
     * Facebook đang dùng, nên "không lỗi" hoàn toàn không có nghĩa là ảnh đã được đính kèm.
     * Ảnh xem trước dùng `blob:` — dấu hiệu này không phụ thuộc ngôn ngữ giao diện.
     */
    imagePreview: [
        'div[role="dialog"] img[src^="blob:"]',
        'div[role="dialog"] [aria-label="Xóa ảnh"]',
        'div[role="dialog"] [aria-label="Xoá ảnh"]',
        'div[role="dialog"] [aria-label="Remove photo"]',
        'div[role="dialog"] [aria-label*="Chỉnh sửa tất cả"]',
        'div[role="dialog"] [aria-label*="Edit all"]',
    ],

    /** Nút đăng bài trong hộp thoại. */
    submitButton: [
        'div[role="dialog"] [aria-label="Đăng"]',
        'div[role="dialog"] [aria-label="Post"]',
        'div[role="dialog"] div[role="button"]:has-text("Đăng"):not(:has-text("Đăng lại"))',
        'div[role="dialog"] div[role="button"]:has-text("Post")',
    ],

    /** Dấu hiệu đã đăng nhập: thanh điều hướng chính chỉ hiện khi có phiên hợp lệ. */
    loggedInMarker: [
        '[aria-label="Facebook"][role="navigation"]',
        'div[role="navigation"] [aria-label="Trang chủ"]',
        'div[role="navigation"] [aria-label="Home"]',
        '[aria-label="Tài khoản của bạn"]',
        '[aria-label="Your profile"]',
    ],

    /** Dấu hiệu đang ở màn hình đăng nhập. */
    loginForm: ['input[name="email"]', '#email', 'form[action*="login"]'],
} as const;

/**
 * Bảng gợi ý tag người mà Facebook bật lên trong lúc gõ bài.
 *
 * KHÔNG scope vào `div[role="dialog"]`: đo thực tế 2026-08-24 cho thấy bảng này được render ở cấp
 * body, ngoài hộp thoại soạn bài (`inDialog: false`), nên mọi selector bám vào dialog đều trượt.
 *
 * Cố ý để rộng ở `[role="listbox"]` thay vì bám `aria-label="Gợi ý lượt nhắc"`: trong lúc đang gõ
 * bài, Facebook bật lên cùng lúc cả bảng gợi ý tag lẫn bảng "gợi ý tìm kiếm", và nhãn của chúng đổi
 * theo ngôn ngữ giao diện. Ở ngữ cảnh này bất kỳ listbox nào đang mở cũng là thứ cần đóng, nên bám
 * theo `role` vừa đủ chính xác vừa không phụ thuộc ngôn ngữ.
 *
 * Đây là phép kiểm tra "popup có đang mở không", không phải chuỗi selector dự phòng để thao tác,
 * nên cố ý tách khỏi `SELECTORS` thay vì thêm một key có đúng một phần tử.
 */
export const SUGGESTION_POPUP_SELECTOR = '[role="listbox"]';

export type SelectorKey = keyof typeof SELECTORS;

/**
 * Các phần tử VỐN LUÔN ẨN — chờ "visible" là chờ mãi không tới.
 *
 * `input[type="file"]` của Facebook bị ẩn hoàn toàn (nút "Ảnh/video" mới là thứ người dùng thấy),
 * nên yêu cầu nó hiển thị khiến `findOptional` luôn trả null: đúng lỗi đã làm mọi bài đăng ngày
 * 2026-08-24 ra không kèm ảnh. `setInputFiles` không cần phần tử hiển thị, chỉ cần nó có trong DOM.
 *
 * Khai báo tại đây thay vì để nơi gọi tự truyền, để không ai có thể quên.
 */
const ATTACHED_ONLY_KEYS: ReadonlySet<SelectorKey> = new Set<SelectorKey>(["fileInput"]);

export class SelectorNotFoundError extends Error {
    constructor(public readonly key: SelectorKey) {
        super(
            `Không tìm thấy phần tử "${key}" với bất kỳ selector dự phòng nào. ` +
                `Facebook nhiều khả năng đã đổi giao diện — cần cập nhật src/facebook/fbSelectors.ts`,
        );
        this.name = "SelectorNotFoundError";
    }
}

/**
 * Thử lần lượt các selector dự phòng, trả về phần tử đầu tiên thực sự hiển thị.
 *
 * Trả về null thay vì ném lỗi để nơi gọi tự quyết định: có phần tử là tuỳ chọn
 * (nút ảnh khi không có ảnh), có phần tử thiếu là hỏng hẳn (ô nhập nội dung).
 */
export async function findOptional(page: Page, key: SelectorKey, timeoutMs = 5_000): Promise<Locator | null> {
    const candidates = SELECTORS[key];
    const perCandidate = Math.max(1_000, Math.floor(timeoutMs / candidates.length));
    const state = ATTACHED_ONLY_KEYS.has(key) ? "attached" : "visible";

    for (const [index, selector] of candidates.entries()) {
        const locator = page.locator(selector).first();
        try {
            await locator.waitFor({ state, timeout: perCandidate });

            if (index > 0) {
                // Selector đầu tiên hỏng là tín hiệu sớm cho thấy Facebook đang đổi giao diện,
                // dù lần này vẫn chạy được nhờ phương án dự phòng.
                log.warn({ key, selector, fallback_index: index }, "Selector chính không dùng được, đã dùng dự phòng");
            }

            return locator;
        } catch {
            continue;
        }
    }

    return null;
}

/** Như findOptional nhưng bắt buộc phải có — dùng cho các phần tử thiếu là không đăng được. */
export async function findRequired(page: Page, key: SelectorKey, timeoutMs = 10_000): Promise<Locator> {
    const locator = await findOptional(page, key, timeoutMs);
    if (!locator) throw new SelectorNotFoundError(key);
    return locator;
}

/** Kiểm tra nhanh sự tồn tại, không chờ lâu — dùng cho các phép kiểm tra trạng thái. */
export async function exists(page: Page, key: SelectorKey, timeoutMs = 3_000): Promise<boolean> {
    return (await findOptional(page, key, timeoutMs)) !== null;
}
