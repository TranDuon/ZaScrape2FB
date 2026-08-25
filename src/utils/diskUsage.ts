import fs from "node:fs/promises";

export interface DiskUsage {
    percentUsed: number;
    totalBytes: number;
    freeBytes: number;
}

/**
 * Dung lượng đĩa của phân vùng chứa `targetPath`, dùng `fs.statfs` — có sẵn trong Node từ bản
 * đã cài (>=20) và chạy được cả trên Windows (dev) lẫn Linux (VPS), không cần thư viện ngoài.
 */
export async function getDiskUsage(targetPath: string): Promise<DiskUsage> {
    const stats = await fs.statfs(targetPath);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    const percentUsed = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

    return { percentUsed, totalBytes, freeBytes };
}
