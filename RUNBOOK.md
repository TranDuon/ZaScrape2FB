# Runbook vận hành

Sổ tay xử lý sự cố cho Sale Room Agent. Mục tiêu: lúc có chuyện, mở đúng một file và biết phải làm gì.

Kiến trúc/thiết kế: [plan.md](plan.md) · Cài đặt/sử dụng: [README.md](README.md)

---

## Kiểm tra nhanh khi thấy bất thường

```bash
curl http://127.0.0.1:3100/health          # trên VPS, hoặc qua SSH tunnel từ máy nhà
systemctl status sale-room-agent           # nếu deploy bằng systemd
pm2 logs sale-room-agent --lines 100       # nếu deploy bằng pm2
tail -n 100 logs/app.$(date +%F).1.log     # log chi tiết
```

Trên Telegram: `/status` (tình trạng hệ thống) và `/stats` (số liệu 7 ngày).

Ý nghĩa `status` trong `/health`:

| Giá trị | Nghĩa | Cần làm gì |
|---|---|---|
| `ok` | Bình thường | Không |
| `degraded` | Một nhánh hỏng, phần còn lại vẫn chạy (mất kết nối Zalo, một cầu dao ngắt, bot Telegram chết, hoặc đĩa >85%) | Xem mục tương ứng bên dưới |
| `down` | Cả cầu dao Facebook lẫn Zalo đều ngắt | Xử lý cả hai mục bên dưới |

---

## Sự cố 1 — Facebook checkpoint / cầu dao đăng bài ngắt

**Dấu hiệu:** Telegram báo `🛑 ĐÃ DỪNG ĐĂNG BÀI LÊN FACEBOOK`. `/health` có `facebook.circuit_breaker: true`.

Cầu dao **không bao giờ tự mở lại**. Đây là cố ý: tiếp tục thao tác trong lúc Facebook đang nghi ngờ
là cách chắc chắn nhất để biến một checkpoint thành khoá tài khoản vĩnh viễn.

1. Xem ảnh chụp màn hình trong `data/fb-screenshots/` (đường dẫn có trong tin nhắn Telegram) để biết
   Facebook đang chặn kiểu gì.
2. **Mở Facebook bằng tay** (trên điện thoại hoặc máy cá nhân, bằng chính tài khoản đó). Hoàn tất mọi
   yêu cầu xác minh. Kiểm tra Trang cá nhân → xem có thông báo hạn chế đăng bài không.
3. Nếu bị hạn chế: **đợi hết hạn rồi mới mở lại cầu dao.** Mở sớm chỉ làm hình phạt nặng thêm.
4. Nếu mọi thứ bình thường trở lại: gõ `/resume` trên Telegram.
5. Sau khi `/resume`, cân nhắc hạ `MAX_POSTS_PER_DAY` xuống 1-2 trong vài ngày rồi mới tăng lại.

> Nếu checkpoint lặp lại nhiều lần: vấn đề là ở mức độ tin cậy của tài khoản, không phải ở code.
> Giảm số nhóm, giảm số bài/ngày, tăng `GROUP_MIN_INTERVAL_MINUTES`.

---

## Sự cố 2 — Phiên Facebook hỏng / bị đăng xuất

**Dấu hiệu:** cầu dao ngắt với lý do `Phiên Facebook không dùng được: ...`.

Agent **cố ý không bao giờ tự điền tài khoản/mật khẩu** — đăng nhập tự động là hành vi Facebook soi
kỹ nhất. Phải đăng nhập tay:

```bash
# Cần nhìn thấy trình duyệt -> tạm đặt FB_HEADLESS=false
# Trên VPS không có màn hình: dùng Xvfb + VNC, hoặc đăng nhập ở máy nhà rồi copy hồ sơ lên
npm run login:facebook     # script tự sao lưu phiên ngay sau khi đăng nhập xong
```

Xong thì đặt lại `FB_HEADLESS=true`, khởi động lại service, rồi `/resume` trên Telegram.

> **Cảnh báo IP:** đăng nhập từ IP khác với IP thường dùng (ví dụ đăng nhập ở nhà rồi mang hồ sơ lên
> VPS) rất dễ kích hoạt checkpoint. Tốt nhất là đăng nhập từ chính IP của VPS.

---

## Sự cố 3 — Phiên Zalo bị kick / hết hạn

**Dấu hiệu:** Telegram báo `⚠️ ZALO`. `/health` có `zalo.connected: false` hoặc `zalo.circuit_breaker: true`.

**Nguyên nhân phổ biến nhất: bạn vừa mở Zalo Web trên trình duyệt.** `zca-js` chỉ cho phép một phiên
web mỗi tài khoản, nên mở ở nơi khác sẽ đá agent ra. Đóng tab Zalo Web đó rồi khởi động lại agent.

Nếu phiên thật sự hết hạn:

```bash
npm run login:zalo         # ghi QR ra data/zalo-session/login-qr.png
scp user@vps:~/sale-room-agent/data/zalo-session/login-qr.png .   # copy về máy để quét
```

Quét bằng app Zalo trên điện thoại. Script tự sao lưu phiên sau khi đăng nhập xong.

> Cầu dao Zalo ngắt **chỉ dừng việc nhận tin mới**. Các tin đã nằm trong MongoDB vẫn được trích xuất,
> soạn bài và đăng lên Facebook bình thường.

---

## Sự cố 4 — Báo "KHÔNG RÕ KẾT QUẢ MỘT LẦN ĐĂNG"

**Dấu hiệu:** Telegram báo `❓ KHÔNG RÕ KẾT QUẢ MỘT LẦN ĐĂNG`.

Nghĩa là tiến trình chết đúng lúc đang đăng — có thể bài đã lên Facebook, có thể chưa. Agent **cố ý
không tự đăng lại**: đăng trùng cùng một nội dung vào cùng một nhóm vừa lộ liễu là bot, vừa không rút
lại được.

1. Mở nhóm Facebook được nhắc trong tin nhắn, xem bài đã có chưa.
2. **Chưa có** → gõ `/retry <mã tin>` trên Telegram.
3. **Đã có** → không cần làm gì.

---

## Sự cố 5 — Không kết nối được Telegram

**Dấu hiệu:** log ghi `Lỗi tạm thời khi nhận tin Telegram, sẽ thử lại` kèm `ConnectTimeoutError`
tới `api.telegram.org:443`.

**Nếu là lỗi TẠM THỜI (mạng chập chờn, ISP bóp Telegram): không cần làm gì.** Thư viện tự thử lại
vô hạn và không advance offset nên không mất tin nhắn nào. Ở Việt Nam việc api.telegram.org lúc
được lúc không là chuyện bình thường. Kiểm tra nhanh:

```bash
curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 https://api.telegram.org/   # mong đợi 302
npm run check:stuck    # muc "Agent" se noi bot con nhan lenh khong
```

**Nếu bot CHẾT HẲN** (`check:stuck` báo "Bot Telegram ĐÃ CHẾT", hoặc `/health` có
`telegram.polling: false`) thì đó là lỗi không tự hồi phục — thường do token sai/bị thu hồi. Lúc này
**mọi lệnh Telegram ngừng hoạt động**, kể cả `/resume`:

```bash
npm run resume -- --status   # xem trang thai cau dao ma khong doi gi
npm run resume               # mo cau dao Facebook khong can Telegram
npm run resume -- --zalo     # mo cau dao Zalo
```

Sau đó kiểm tra `TELEGRAM_BOT_TOKEN` trong `.env` (lấy token mới từ @BotFather nếu cần) rồi khởi
động lại agent.

> Đây chính là tình huống kẹt cứng mà `npm run resume` sinh ra để phá: cầu dao ngắt **và** Telegram
> không dùng được thì agent dừng vĩnh viễn, vì đường phục hồi duy nhất lại nằm sau kênh vừa chết.

---

## Sự cố 6 — Đĩa sắp đầy

**Dấu hiệu:** Telegram báo `⚠️ ĐĨA SẮP ĐẦY`, hoặc `/health` có `disk_usage_percent` cao.

```bash
npm run cleanup:images -- --force    # bỏ qua điều kiện tuổi, dọn ngay
du -sh data/* logs/                  # xem thứ gì đang chiếm chỗ
```

Nếu vẫn đầy: giảm `IMAGE_RETENTION_DAYS` (mặc định 30) và `LOG_RETENTION_DAYS` (mặc định 7), hoặc
nâng dung lượng ổ.

> `--force` chỉ xoá ảnh của tin đã `posted`/`ignored`/`rejected`. Ảnh của tin `failed`/`duplicate`
> luôn được giữ lại vì `/retry` còn cần đến.

---

## Sự cố 7 — VPS khởi động lại / agent chết

`systemd` (hoặc `pm2`) tự khởi động lại. Việc cần làm:

1. `curl http://127.0.0.1:3100/health` — kiểm tra đã chạy lại chưa.
2. Nếu `zalo.connected: false` sau vài phút → xem Sự cố 3.
3. Job dở dang tự được dọn lúc khởi động: job trích xuất/soạn bài quay lại hàng đợi, job **đăng bài
   thì không** (xem Sự cố 4 — chống đăng trùng).

---

## Sự cố 8 — MongoDB Atlas không kết nối được

1. Kiểm tra Network Access trong Atlas UI — IP của VPS còn trong danh sách cho phép không?
   (IP VPS đổi sau khi rebuild máy là nguyên nhân hay gặp.)
2. Gói M0 có bảo trì định kỳ, downtime ngắn — driver MongoDB tự thử lại, thường tự khỏi.
3. Kiểm tra đã dùng đúng dạng `mongodb+srv://` chưa (không phải `mongodb://`).

---

## Sao lưu & khôi phục

### Cái gì được sao lưu

| Dữ liệu | Cách | Tần suất |
|---|---|---|
| Phiên Zalo + hồ sơ Facebook | `npm run backup:sessions` → `data/session-backups/` | Tự động sau mỗi lần đăng nhập + Chủ nhật 3h45 sáng |
| MongoDB | `mongodump` (Atlas M0 không có sao lưu tự động) | Nên đặt cron riêng, 3-4h sáng |
| `.env` | Chép tay vào trình quản lý mật khẩu | Mỗi khi đổi |

> **Bản sao nằm trên chính VPS, nên mất VPS là mất luôn bản sao.** Định kỳ copy
> `data/session-backups/` về máy cá nhân hoặc cloud. Bản sao đã bỏ cache nên chỉ ~5MB.

### Khôi phục phiên

```bash
systemctl stop sale-room-agent                       # BẮT BUỘC dừng trước khi khôi phục
rm -rf data/zalo-session data/fb-browser-profile
cp -r data/session-backups/<bản-cần-dùng>/zalo-session data/
cp -r data/session-backups/<bản-cần-dùng>/fb-browser-profile data/
systemctl start sale-room-agent
curl http://127.0.0.1:3100/health                    # xác nhận zalo.connected = true
```

Khôi phục xong nên chạy `npm run test:fbpost -- <id-group> --dry-run` để chắc chắn phiên Facebook
còn dùng được, **trước khi** để agent tự đăng.

> **Đã diễn tập thật ngày 21/08/2026** (khôi phục bản 4.7MB đè lên hồ sơ 218MB, chạy dry-run):
> phiên vẫn hợp lệ, luồng đăng chạy đủ 5 bước. Việc lược bỏ cache của Chrome **không** làm hỏng phiên.
>
> Cách diễn tập an toàn (có đường lùi, không mất gì nếu bản sao hỏng): **đổi tên** hồ sơ gốc thay vì
> xoá — `mv data/fb-browser-profile data/fb-browser-profile.original` — rồi mới copy bản sao vào.
> Thử xong thì xoá bản khôi phục và đổi tên hồ sơ gốc trở lại.

---

## Bảo mật

- `.env` phải `chmod 600`. `data/` chứa credential cũng vậy.
- **Không bao giờ** mở `/health` ra internet — nó lộ toàn bộ tình trạng vận hành. Mặc định chỉ nghe
  `127.0.0.1`, xem từ xa qua `ssh -L 3100:127.0.0.1:3100 user@vps`.
- `TELEGRAM_CHAT_ID` là lớp bảo vệ **duy nhất** cho bot. Lộ token mà không lộ chat ID thì người lạ
  vẫn không ra lệnh được — nhưng đổi token ngay nếu nghi ngờ bị lộ.
