import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { businessDateKey } from "../utils/time.js";

const log = childLogger("maintenance:backup");

/**
 * Thư mục con của hồ sơ Chrome KHÔNG cần sao lưu.
 *
 * Hồ sơ thật ~218MB nhưng gần 200MB trong đó là cache tự sinh lại được (Cache, Code Cache,
 * cache shader/GPU, kho model gợi ý, số liệu đo đạc). Thứ thực sự giữ cho phiên còn sống là
 * `Default/Network/Cookies`, `Default/Local Storage` và `Default/Preferences` — chỉ vài MB.
 * Bỏ cache đi giúp bản sao lưu nhẹ hơn ~20 lần, đủ nhẹ để giữ nhiều bản và copy đi nơi khác.
 */
const SKIP_DIRECTORIES = new Set([
    "Cache",
    "Code Cache",
    "GPUCache",
    "GrShaderCache",
    "ShaderCache",
    "GPUPersistentCache",
    "DawnWebGPUCache",
    "DawnGraphiteCache",
    "optimization_guide_model_store",
    "BrowserMetrics",
    "component_crx_cache",
    "extensions_crx_cache",
    "Crashpad",
]);

export interface BackupResult {
    /** Thư mục chứa bản sao lưu vừa tạo. */
    destination: string;
    bytes: number;
    /** Số bản sao lưu cũ đã xoá theo chính sách giữ lại. */
    rotated: number;
}

async function directorySize(dir: string): Promise<number> {
    let total = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += await directorySize(full);
        else if (entry.isFile()) total += (await fs.stat(full)).size;
    }

    return total;
}

async function copySession(source: string, destination: string): Promise<boolean> {
    try {
        await fs.access(source);
    } catch {
        log.warn({ source }, "Không có thư mục phiên để sao lưu, bỏ qua");
        return false;
    }

    await fs.cp(source, destination, {
        recursive: true,
        // Bỏ cache: xem chú thích ở SKIP_DIRECTORIES.
        filter: (src) => !SKIP_DIRECTORIES.has(path.basename(src)),
        // Hồ sơ Chrome có file khoá/socket đang mở; lỗi một file lẻ không được làm hỏng cả bản sao.
        force: true,
    });

    return true;
}

/** Xoá bớt bản sao lưu cũ, chỉ giữ `SESSION_BACKUP_KEEP` bản mới nhất. */
async function rotate(backupRoot: string): Promise<number> {
    const entries = await fs.readdir(backupRoot, { withFileTypes: true });
    const dirs = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort() // tên bắt đầu bằng ngày ISO nên sắp xếp chuỗi cũng là sắp xếp thời gian
        .reverse();

    const excess = dirs.slice(env.SESSION_BACKUP_KEEP);

    for (const name of excess) {
        await fs.rm(path.join(backupRoot, name), { recursive: true, force: true });
    }

    return excess.length;
}

/**
 * Sao lưu phiên đăng nhập Zalo + hồ sơ trình duyệt Facebook.
 *
 * LƯU Ý về tính nhất quán: hồ sơ Chrome là một tập file SQLite. Sao lưu trong lúc agent đang mở
 * trình duyệt có thể chép phải file đang bị ghi dở. Bản sao vẫn thường dùng lại được (cookie là
 * thứ quan trọng nhất và hiếm khi bị ghi), nhưng bản sao chắc chắn sạch nhất là bản chạy ngay
 * sau `npm run login:facebook`, lúc trình duyệt vừa đóng hẳn — đó cũng là lúc nó đáng giá nhất.
 */
export async function backupSessions(): Promise<BackupResult> {
    const stamp = `${businessDateKey()}-${String(Date.now()).slice(-6)}`;
    const backupRoot = path.resolve(env.SESSION_BACKUP_DIR);
    const destination = path.join(backupRoot, stamp);

    await fs.mkdir(destination, { recursive: true });

    const zaloOk = await copySession(path.resolve(env.ZALO_SESSION_DIR), path.join(destination, "zalo-session"));
    const fbOk = await copySession(
        path.resolve(env.FB_BROWSER_PROFILE_DIR),
        path.join(destination, "fb-browser-profile"),
    );

    if (!zaloOk && !fbOk) {
        // Không có gì để sao lưu thì đừng để lại thư mục rỗng làm nhiễu vòng xoay bản cũ.
        await fs.rm(destination, { recursive: true, force: true });
        throw new Error("Không tìm thấy phiên Zalo lẫn hồ sơ Facebook nào để sao lưu");
    }

    const bytes = await directorySize(destination);
    const rotated = await rotate(backupRoot);

    log.info(
        { destination, mb: (bytes / 1024 ** 2).toFixed(1), zalo: zaloOk, facebook: fbOk, rotated },
        "Đã sao lưu phiên đăng nhập",
    );

    return { destination, bytes, rotated };
}
