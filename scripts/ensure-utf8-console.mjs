/**
 * Chuyển console Windows sang UTF-8 (code page 65001) trước khi chạy script.
 *
 * Chỉ cần trên máy dev Windows: cmd.exe/PowerShell mặc định dùng code page
 * theo vùng (thường là 850/1258 ở VN), làm tiếng Việt trong log hiện sai ký tự.
 * Trên VPS Linux (nơi service thật sự chạy 24/7) terminal đã UTF-8 sẵn nên
 * script này tự bỏ qua, không có tác dụng gì và không gây lỗi.
 */
if (process.platform === "win32") {
    const { execSync } = await import("node:child_process");
    try {
        // stdio "inherit": chcp đổi code page của CHÍNH console đang mở,
        // không phải của tiến trình con — nên phải chạy trước khi tsx in dòng nào.
        execSync("chcp 65001", { stdio: "ignore" });
    } catch {
        // Không chặn việc chạy script chỉ vì đổi code page thất bại.
    }
}
