@echo off
chcp 65001 >nul
echo.
echo ============================================================
echo   MO CHROME THUONG DE DANG NHAP FACEBOOK
echo ============================================================
echo.
echo   Chrome se mo voi profile rieng cua du an (khong anh huong
echo   Chrome ca nhan cua ban).
echo.
echo   1. Dang nhap Facebook binh thuong trong cua so vua mo
echo   2. Sau khi vao duoc trang chu Facebook → DONG CHROME LAI
echo   3. Quay lai day chay: npm run login:facebook
echo      De kiem tra phien da luu thanh cong.
echo.
echo ============================================================
echo.

:: Tim Chrome
set "CHROME="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
) else (
    for /f "tokens=*" %%i in ('where chrome 2^>nul') do set "CHROME=%%i"
)

if "%CHROME%"=="" (
    echo LOI: Khong tim thay Chrome. Hay cai dat Google Chrome truoc.
    pause
    exit /b 1
)

:: Duong dan tuyet doi den profile cua du an
set "PROFILE_DIR=%~dp0data\fb-browser-profile"

echo Dang mo Chrome voi profile: %PROFILE_DIR%
echo.

:: Mo Chrome THUONG (khong bi Playwright dieu khien)
:: voi user-data-dir tro vao cung thu muc Playwright se doc
start "" "%CHROME%" --user-data-dir="%PROFILE_DIR%" --no-first-run --disable-infobars https://www.facebook.com

echo Chrome da mo. Hay dang nhap Facebook trong do.
echo Sau khi xong, DONG CHROME roi quay lai day.
echo.
pause
