# Gỡ tự khởi động. Chạy: npm run autostart:remove
# Chỉ gỡ shortcut; dashboard đang chạy vẫn chạy tiếp — tắt bằng: npm run dashboard:stop
$ErrorActionPreference = "Stop"

$targets = @(
    (Join-Path ([Environment]::GetFolderPath("Startup")) "Sale Room Agent.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "Sale Room Dashboard.url")
)

foreach ($target in $targets) {
    if (Test-Path $target) {
        Remove-Item $target
        Write-Host "Đã xoá: $target"
    }
}

Write-Host "Đã gỡ tự khởi động. Dashboard đang chạy (nếu có) vẫn chạy tiếp — tắt bằng: npm run dashboard:stop"
