# Tắt hẳn dashboard đang chạy ẩn — dừng agent ÊM trước, rồi dashboard tự thoát.
# Chạy: npm run dashboard:stop
#
# Cần khi cập nhật code của CHÍNH dashboard (src/dashboard/): nút "Khởi động lại" trên dashboard chỉ
# nạp lại agent, còn tiến trình dashboard thì vẫn là bản cũ tới khi tắt hẳn rồi chạy lại.
#
# KHÔNG giết thẳng tiến trình dashboard trừ khi hết cách: trên Windows, agent là tiến trình con nằm
# trong job object của dashboard, dashboard chết là agent (cùng Chrome của Playwright) bị giết cứng
# theo — không kịp đóng trình duyệt hay chốt tin nhắn Zalo đang gom. Vì vậy đi đường HTTP trước.
$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$port = 3200
$envLine = Select-String -Path (Join-Path $repo ".env") -Pattern '^\s*DASHBOARD_PORT\s*=\s*(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($envLine) { $port = [int]$envLine.Matches[0].Groups[1].Value }

function Get-DashboardProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -like "*src/dashboard/main.ts*" }
}

if (-not (Get-DashboardProcesses)) {
    Write-Host "Không có dashboard nào đang chạy."
    exit 0
}

try {
    $response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/dashboard/quit" `
        -Headers @{ "x-dashboard-action" = "1" } -TimeoutSec 10
    Write-Host $response.message
} catch {
    Write-Warning "Không gọi được dashboard qua HTTP: $($_.Exception.Message)"
}

# Agent tự tắt êm tối đa ~45s (xem GRACEFUL_STOP_MS trong src/dashboard/agentProcess.ts).
$deadline = (Get-Date).AddSeconds(60)
while ((Get-DashboardProcesses) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }

$left = Get-DashboardProcesses
if ($left) {
    Write-Warning "Dashboard không tự tắt sau 60 giây — buộc phải giết cứng (agent bị giết theo)."
    foreach ($proc in $left) { Stop-Process -Id $proc.ProcessId -Force }
    exit 1
}

Write-Host "Đã tắt dashboard và agent."
