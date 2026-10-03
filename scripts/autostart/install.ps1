# Bật tự khởi động: mỗi lần đăng nhập Windows, dashboard (và agent bên trong nó) tự chạy ẩn.
# Chạy: npm run autostart:install      Gỡ: npm run autostart:remove
#
# Dùng shortcut trong thư mục Startup chứ không dùng Task Scheduler hay Windows Service:
# - Không cần quyền admin.
# - Chạy TRONG phiên đăng nhập của người dùng. Playwright cần phiên này khi FB_HEADLESS=false, và
#   Service chạy ở session 0 không có màn hình. Hồ sơ Chrome/Zalo cũng là của user này.
# Hệ quả: agent chạy khi ĐĂNG NHẬP, không phải lúc bật nguồn. Muốn bật máy là chạy thì bật
# tự đăng nhập Windows (netplwiz).
#
# File lưu dạng UTF-8 có BOM — PowerShell 5.1 đọc file không BOM theo bảng mã ANSI, tiếng Việt sẽ vỡ.
$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$vbs = Join-Path $PSScriptRoot "launch-hidden.vbs"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "Không tìm thấy node trong PATH. Cài Node.js >= 20 trước." }
$node = $nodeCmd.Source

if (-not (Test-Path (Join-Path $repo "node_modules\tsx"))) { throw "Chưa có node_modules — chạy npm install trước." }
if (-not (Test-Path (Join-Path $repo ".env"))) { throw "Chưa có file .env — copy từ .env.example rồi điền trước." }

$port = 3200
$envLine = Select-String -Path (Join-Path $repo ".env") -Pattern '^\s*DASHBOARD_PORT\s*=\s*(\d+)' | Select-Object -First 1
if ($envLine) { $port = [int]$envLine.Matches[0].Groups[1].Value }
$dashboardUrl = "http://127.0.0.1:$port/"

# 1. Shortcut trong Startup — thứ thực sự làm việc tự khởi động.
$startupLnk = Join-Path ([Environment]::GetFolderPath("Startup")) "Sale Room Agent.lnk"
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($startupLnk)
$lnk.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
$lnk.Arguments = "`"$vbs`" `"$node`""
$lnk.WorkingDirectory = $repo
$lnk.Description = "Sale Room Agent - dashboard + agent chay an"
$lnk.Save()
Write-Host "Đã tạo shortcut khởi động: $startupLnk"

# 2. Lối tắt mở dashboard trên Desktop.
$desktopUrl = Join-Path ([Environment]::GetFolderPath("Desktop")) "Sale Room Dashboard.url"
Set-Content -Path $desktopUrl -Value "[InternetShortcut]`r`nURL=$dashboardUrl`r`n" -Encoding ASCII
Write-Host "Đã tạo lối tắt trên Desktop: $desktopUrl"

# 3. Chạy luôn bây giờ, khỏi phải đăng xuất rồi đăng nhập lại.
function Test-Port([int]$p) {
    $client = New-Object System.Net.Sockets.TcpClient
    try { $client.Connect("127.0.0.1", $p); return $true } catch { return $false } finally { $client.Dispose() }
}

if (Test-Port $port) {
    Write-Host "Dashboard đã đang chạy — không mở thêm."
} else {
    Start-Process -FilePath (Join-Path $env:WINDIR "System32\wscript.exe") -ArgumentList "`"$vbs`"", "`"$node`"" -WorkingDirectory $repo
    Write-Host "Đang khởi động dashboard..."
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Port $port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Port $port)) {
        Write-Warning "Dashboard chưa lên sau 30 giây. Xem logs\dashboard\startup-error.log, hoặc chạy thử 'npm run dashboard' để thấy lỗi trực tiếp."
        exit 1
    }
}

Write-Host ""
Write-Host "Xong. Dashboard: $dashboardUrl"
Write-Host "Từ giờ mỗi lần đăng nhập Windows, agent tự chạy. KHÔNG cần gõ npm run dev nữa"
Write-Host "(chạy song song sẽ bị chặn, vì hai phiên Zalo sẽ đá nhau ra)."
Start-Process $dashboardUrl
