import fs from "node:fs/promises";
import path from "node:path";
import { Zalo, type API, type Credentials } from "zca-js";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("zalo:client");

const SESSION_FILE = "credentials.json";

/** User agent cố định: đổi UA liên tục giữa các lần đăng nhập là dấu hiệu bất thường. */
const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface StoredSession {
    imei: string;
    cookie: unknown;
    userAgent: string;
    language: string;
    saved_at: string;
}

function sessionPath(): string {
    return path.resolve(env.ZALO_SESSION_DIR, SESSION_FILE);
}

export async function loadSession(): Promise<StoredSession | null> {
    try {
        const raw = await fs.readFile(sessionPath(), "utf8");
        return JSON.parse(raw) as StoredSession;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export async function saveSession(session: Omit<StoredSession, "saved_at">): Promise<void> {
    const target = sessionPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify({ ...session, saved_at: new Date().toISOString() }, null, 2), {
        // 0600: file này là chìa khoá vào tài khoản Zalo, không để user khác trên VPS đọc được.
        mode: 0o600,
    });
    log.info({ path: target }, "Đã lưu phiên đăng nhập Zalo");
}

export async function hasSession(): Promise<boolean> {
    return (await loadSession()) !== null;
}

/**
 * Đăng nhập bằng phiên đã lưu. Ném lỗi nếu chưa có phiên — việc quét QR
 * là thao tác tương tác, phải chạy `npm run login:zalo` một lần bằng tay.
 */
export async function loginWithSavedSession(): Promise<API> {
    const session = await loadSession();
    if (!session) {
        throw new Error(`Chưa có phiên Zalo tại ${sessionPath()}. Chạy: npm run login:zalo`);
    }

    const zalo = new Zalo();
    const credentials: Credentials = {
        imei: session.imei,
        cookie: session.cookie as Credentials["cookie"],
        userAgent: session.userAgent,
        language: session.language,
    };

    const api = await zalo.login(credentials);
    const ownId = api.getOwnId();
    log.info({ own_id: ownId }, "Đăng nhập Zalo bằng phiên đã lưu thành công");
    return api;
}

/**
 * Đăng nhập bằng QR và lưu phiên lại. Chỉ dùng trong script chạy tay
 * vì cần người quét mã bằng điện thoại.
 */
export async function loginWithQR(onQRPath?: (qrPath: string) => void): Promise<API> {
    const zalo = new Zalo();
    const qrPath = path.resolve(env.ZALO_SESSION_DIR, "login-qr.png");
    await fs.mkdir(path.dirname(qrPath), { recursive: true });

    const api = await zalo.loginQR({ userAgent: DEFAULT_USER_AGENT, qrPath }, async (event) => {
        switch (event.type) {
            case 0: // QRCodeGenerated
                await event.actions.saveToFile(qrPath);
                log.info({ qr_path: qrPath }, "Đã sinh mã QR — mở file này và quét bằng app Zalo");
                onQRPath?.(qrPath);
                break;
            case 1: // QRCodeExpired
                log.warn("Mã QR hết hạn, đang sinh mã mới");
                event.actions.retry();
                break;
            case 2: // QRCodeScanned
                log.info({ display_name: event.data.display_name }, "Đã quét QR, chờ xác nhận trên điện thoại");
                break;
            case 3: // QRCodeDeclined
                log.error("Đăng nhập bị từ chối trên điện thoại");
                break;
            case 4: // GotLoginInfo
                await saveSession({
                    imei: event.data.imei,
                    cookie: event.data.cookie,
                    userAgent: event.data.userAgent,
                    language: "vi",
                });
                break;
        }
    });

    // Xoá ảnh QR sau khi xong: file này cho phép chiếm phiên nếu bị lộ.
    await fs.rm(qrPath, { force: true });
    return api;
}
