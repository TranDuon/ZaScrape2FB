# Runbook vận hành

Sổ tay xử lý sự cố cho Sale Room Agent. Mục tiêu: lúc có chuyện, mở đúng một file và biết phải làm gì.

Kiến trúc/thiết kế: [plan.md](plan.md) · Cài đặt/sử dụng: [README.md](README.md)

---

## Kiểm tra nhanh khi thấy bất thường

Trên máy Windows đã chạy `npm run autostart:install`: mở <http://127.0.0.1:3200> (lối tắt
**Sale Room Dashboard** trên Desktop). Dashboard hiện mọi thứ dưới đây kèm log trực tiếp.

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

## Sự cố 7b — Máy Windows: dashboard không mở được / agent không tự chạy

1. Mở <http://127.0.0.1:3200>. Không vào được nghĩa là tiến trình dashboard không chạy:
   - Xem `logs/dashboard/startup-error.log`. Lỗi hay gặp nhất là `.env` không hợp lệ. Khi đó chính
     dashboard cũng không dựng lên được, và vì chạy ẩn nên file này là dấu vết duy nhất.
   - Chạy `npm run dashboard` trong một cửa sổ để thấy lỗi trực tiếp.
   - Kiểm tra shortcut còn trong thư mục Startup (`Win+R` → `shell:startup` → `Sale Room Agent`).
     Mất thì chạy lại `npm run autostart:install`. Đổi chỗ cài Node.js cũng cần cài lại, vì
     đường dẫn `node.exe` được ghi cứng vào shortcut.
2. Dashboard mở được nhưng agent **"Vừa chết — chờ chạy lại"**: đọc các dòng đỏ trong Log trực tiếp.
   Lúc vừa mở máy mà chưa có mạng thì MongoDB lỗi là bình thường; dashboard tự thử lại.
3. Agent **"Chạy ngoài dashboard"**: có một cửa sổ `npm run dev` đang giữ agent. Tắt cửa sổ đó,
   dashboard sẽ tự nhận quản lý trong vòng 30 giây.
4. Tắt/giết thẳng tiến trình dashboard (Task Manager) sẽ **giết cứng agent theo**, cả Chrome của
   Playwright (job object của Windows). Luôn tắt bằng nút **Dừng** hoặc `npm run dashboard:stop`.
   Hồ sơ trình duyệt hỏng nghĩa là phải đăng nhập Facebook lại bằng tay.
5. **Đã bấm Tắt máy / Khởi động lại nhưng máy không tắt hẳn** (một ứng dụng chặn lại, hoặc bấm Huỷ):
   Windows vẫn đóng các ứng dụng của phiên trước đó, nên dashboard và agent đã chết. Máy không đăng
   xuất nên shortcut Startup không chạy lại, và agent nằm im cho tới lần đăng nhập sau. Gặp ngày
   2026-10-04: log dừng 02:40, Event Viewer → System có sự kiện **1073** ("restart/shutdown ... failed")
   lúc 02:56. Cách xử lý: chạy lại `wscript scripts\autostart\launch-hidden.vbs` (hoặc đăng xuất rồi
   đăng nhập lại).
6. **Máy ngủ thì agent cũng ngủ.** Các việc cron lúc 3h sáng (cho tin quá hạn hết hiệu lực, dọn ảnh,
   sao lưu phiên Chủ nhật) chỉ chạy được những đêm máy còn thức. Kiểm tra:
   `grep -l listings_expired logs/app.*.log`.

---

## Sự cố 8 — MongoDB Atlas không kết nối được

1. Kiểm tra Network Access trong Atlas UI — IP của VPS còn trong danh sách cho phép không?
   (IP VPS đổi sau khi rebuild máy là nguyên nhân hay gặp.)
2. Gói M0 có bảo trì định kỳ, downtime ngắn — driver MongoDB tự thử lại, thường tự khỏi.
3. Kiểm tra đã dùng đúng dạng `mongodb+srv://` chưa (không phải `mongodb://`).

---

## Sự cố 9 — Hệ thống soạn bài, xếp lịch nhưng KHÔNG đăng gì cả

Dấu hiệu: Telegram vẫn báo "Đã trích xuất từ Zalo…" đều đặn nhưng nhiều giờ/nhiều ngày không có một
tin "✅ Đã đăng…" nào; `/status` cho thấy nhiều tin ở trạng thái `queued`; cầu dao **không** ngắt.

1. `npm run check:stuck` — mục "Job đến hạn nhưng chưa chạy" nay tự loại trừ các lý do chính đáng.
   Nếu nó báo `[!] N job quá hạn ... mà KHÔNG có lý do chính đáng` thì bộ điều phối thật sự đã hỏng.
2. Xem log: `grep "Nhịp điều phối bỏ qua" logs/app.<ngày>.1.log | tail -20`. Mỗi nhịp bỏ qua đều
   kèm lý do. Cùng một lý do lặp lại suốt cả ngày mà không có bài nào lên là bất thường.
3. Kiểm tra bộ đếm ngày trong `app_state`:

```bash
npm run check:db      # in ra "ngày hiện tại (giờ VN)" của daily_counters
```

Nếu `daily_counters.date` **không phải hôm nay**, bộ đếm đã kẹt ở một ngày cũ. Từ 2026-09-06
`runCycle` đọc qua `postsTodayCount()` nên bộ đếm tự lật ngày ở nhịp kế tiếp — chỉ cần khởi động
lại agent và chờ một nhịp (`SCHEDULER_TICK_CRON`, mặc định 20 phút). Không cần sửa tay MongoDB.

Nguyên nhân gốc đã khắc phục (xem CLAUDE.md, mục "Two pacing models coexist"): chốt chặn hạn mức
ngày đọc số thô nên tự khoá chính nó — nó chặn luôn đoạn mã duy nhất reset được con số đang chặn nó.

4. Backlog tồn lại sẽ chảy ra với tốc độ **một bài/nhịp** và tối đa `MAX_POSTS_PER_DAY` bài/ngày —
   đó là hành vi đúng, đừng nới nhịp cron để đẩy nhanh (xem cảnh báo về tần suất đăng trong
   CLAUDE.md). Tin quá `LISTING_MAX_AGE_DAYS` ngày sẽ tự chuyển sang `expired` và không đăng nữa.

---

## Sự cố 10 — Khách nhắn tin mà Telegram không báo

Agent báo hai nguồn: tin Zalo 1-1 gửi tới tài khoản Zalo của agent (`zalo:dm-alert`) và hộp thư
Messenger của tài khoản đăng bài, gồm cả mục "Tin nhắn đang chờ" của người lạ (`fb:inbox`, chạy theo
`FB_INBOX_CHECK_CRON`, mặc định 15 phút một lần từ 6h tới 23h59).

1. Dòng `Agent đang chạy` lúc khởi động có mục `Báo tin nhắn khách`. Nếu ghi `tắt` thì kiểm tra
   `ZALO_DM_ALERT_ENABLED` / `FB_INBOX_CHECK_CRON` trong `.env`.
2. Messenger: `grep '"fb:inbox"' logs/app.<ngày>.1.log | tail`. Mỗi lượt ghi một dòng
   "Đã kiểm tra hộp thư Messenger" kèm số hội thoại. Không có dòng nào thì:
   - Cầu dao Facebook đang ngắt (lượt kiểm tra cố ý bỏ qua để không tải thêm trang nào), hoặc
   - Ngoài giờ trong `FB_INBOX_CHECK_CRON`.
3. Telegram báo "N lần liên tiếp không đọc được hộp thư Messenger" nghĩa là giao diện Facebook đã đổi.
   Bộ đọc lấy các thẻ `a[href*="/messages/"][href*="/t/"]` và tách `innerText`, xem
   `src/facebook/inboxParser.ts` (có chuỗi mẫu thật trong comment và trong
   `test/unit/inboxParser.test.ts`).
4. Muốn nhận lại bản tổng hợp toàn bộ hộp thư (như lần chạy đầu) thì xoá collection
   `fb_inbox_threads`: lượt kiểm tra kế tiếp sẽ coi như lần đầu.
5. Nội dung tin Messenger hiện là "(mã hoá đầu cuối)": trình duyệt của agent không có mã PIN khôi phục
   tin mã hoá, nên chỉ biết **ai** nhắn và **lúc nào**. Muốn đọc và trả lời thì đăng nhập tài khoản
   đăng bài trên app Messenger của điện thoại.

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
