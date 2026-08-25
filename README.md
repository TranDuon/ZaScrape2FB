# Sale Room Agent

Agent tự động: nhận tin đăng phòng trọ từ Zalo → trích xuất bằng LLM → lưu MongoDB → đăng lên các group Facebook.

Kế hoạch tổng thể: [plan.md](plan.md) · Xử lý sự cố khi đang chạy: [RUNBOOK.md](RUNBOOK.md)

## Trạng thái các module

| Module | Trạng thái |
|---|---|
| 1. Zalo listener (nhận tin, gom batch, tải ảnh, lưu MongoDB) | Đã xong |
| 2. Trích xuất dữ liệu bằng Gemini (phân loại + bóc tách field) | Đã xong |
| 3. Quản lý group Facebook (CRUD) + hàng đợi job đã kiểm chứng | Đã xong |
| 4. Post composer (nhiều biến thể + xếp lịch giãn cách) | Đã xong |
| 5. Facebook auto-poster (Playwright + cầu dao + giới hạn tần suất) | Đã xong |
| 6. Scheduler + Telegram bot + health endpoint | Đã xong |
| 7. Testing (vitest) + log rotation + dọn ảnh/screenshot + cảnh báo đầy đĩa | Đã xong |
| 8. Chống đăng trùng khi crash + sao lưu phiên + deploy chạy nền + runbook | Đã xong |

## Cài đặt

```bash
npm install
cp .env.example .env      # rồi điền MONGODB_URI (Atlas) và GEMINI_API_KEY
```

Lấy Gemini API key miễn phí tại <https://aistudio.google.com/apikey>.
Để trống `GEMINI_API_KEY` thì agent vẫn chạy và vẫn lưu tin nhắn Zalo — chỉ riêng worker trích xuất không hoạt động.

## Đăng nhập Zalo (chạy tay một lần)

```bash
npm run login:zalo
```

Lệnh này ghi mã QR ra `data/zalo-session/login-qr.png`. Quét bằng app Zalo trên điện thoại.
Phiên được lưu vào `data/zalo-session/credentials.json` (quyền 0600) và dùng lại cho các lần chạy sau.

Trên VPS không có màn hình: copy file QR về máy để quét.

```bash
scp user@vps:~/sale-room-agent/data/zalo-session/login-qr.png .
```

## Chạy

```bash
npm run dev        # chế độ phát triển, tự khởi động lại khi sửa code
npm start          # chạy thường
npm run typecheck  # kiểm tra kiểu TypeScript
```

## Kiểm thử nhanh (không cần MongoDB)

```bash
npm test                # vitest: gom tin nhắn, nhận dạng chữ/ảnh, khoá ngày giờ VN, confidence gate,
                         # parse số, "bộ não" điều phối rate-limit/circuit-breaker (scheduleLogic)
npm run test:watch      # vitest ở chế độ theo dõi, chạy lại khi sửa code
npm run test:jobqueue   # kiểm chứng claim đồng thời + /retry, chạy trên Atlas thật (tự dọn dữ liệu test)
npm run test:facebook   # dò checkpoint, selector dự phòng, giới hạn tần suất — trang giả, không đụng Facebook
npm run test:telegram   # gửi tin thật + kiểm tra health endpoint
```

## Kiểm thử composer (gọi Gemini thật + ghi Atlas, tự dọn dữ liệu)

```bash
npm run test:composer
```

Soạn bài cho một tin đăng mẫu, in ra từng biến thể kèm lịch đăng, đo mức trùng lặp giữa các
biến thể, rồi thử luồng soạn lại sau khi người dùng sửa nội dung.

## Quản lý danh sách group Facebook

```bash
npm run seed:groups -- list
npm run seed:groups -- add "Tên nhóm" "https://facebook.com/groups/..." [max/ngày=5] [cách nhau tối thiểu phút=180]
npm run seed:groups -- toggle <id>   # bật/tắt mà không cần xoá
npm run seed:groups -- remove <id>
```

## Kiểm thử chất lượng trích xuất (gọi Gemini thật, tốn quota)

```bash
npm run test:extractor
```

Chạy 6 tin nhắn mẫu trong `test/fixtures/sample-messages.json` (tin đăng đầy đủ, tin thiếu giá,
banner chính sách, người đi thuê hỏi phòng, tin xã giao, tin viết tắt tiền khó) rồi in ra
từng field bóc tách được kèm kết luận phân loại đúng/sai.

## Cách dữ liệu chảy qua hệ thống

1. Tin nhắn Zalo đến → gom chữ + album ảnh thành một tin đăng (chờ 45 giây im lặng) → lưu `listings` ở trạng thái `received`.
2. Worker trích xuất lấy job → gửi chữ + tối đa 4 ảnh (đã thu nhỏ) cho Gemini → nhận JSON có cấu trúc.
3. Confidence gate quyết định:
   - Không phải tin đăng phòng → `ignored`, dừng tại đây (không tốn chi phí ở các bước sau).
   - Thiếu giá / địa chỉ / liên hệ, hoặc độ tin cậy dưới ngưỡng → `needs_review`, chờ người duyệt.
   - Đủ điều kiện → `ready`, tự động tạo job soạn bài đăng.
4. Worker soạn bài sinh **nhiều biến thể khác nhau trong một lần gọi Gemini** (mỗi group một biến thể,
   vì đăng nội dung giống hệt lên nhiều nhóm là dấu hiệu spam rõ nhất với Facebook) → listing chuyển
   `queued`, mỗi group có một job đăng riêng với mốc thời gian giãn cách ngẫu nhiên.
5. Nếu sửa nội dung khi đã `queued` → huỷ các job chưa chạy, quay về `ready`, soạn lại. Group đã đăng
   xong thì giữ nguyên (bài trên Facebook không rút lại được).

## Đăng bài Facebook

```bash
npm run login:facebook                       # đăng nhập TAY một lần (cần FB_HEADLESS=false)
npm run test:fbpost -- <id-group> --dry-run  # thử toàn bộ thao tác, KHÔNG bấm nút Đăng
npm run test:fbpost -- <id-group>            # đăng thật một bài lên đúng một nhóm
```

Luôn chạy `--dry-run` trước. Nó đi hết mọi bước (mở nhóm, mở hộp soạn bài, gõ nội dung, tìm nút Đăng)
rồi dừng ngay trước khi đăng, và chụp lại màn hình — đủ để biết Facebook có đổi giao diện hay không
mà không tốn một lượt nào trong hạn mức ngày.

### Rủi ro tài khoản — đọc trước khi bật tự động

Tài khoản Facebook càng mới thì càng dễ bị khoá khi tự động hoá. Nếu dùng tài khoản vừa tạo:

- **Nuôi tài khoản 2-4 tuần** bằng cách dùng tay như người thật trước khi bật agent.
- **Bắt đầu với 1-2 nhóm**, mỗi ngày 1-2 bài. `MAX_POSTS_PER_DAY` mặc định để **3**, cố ý thấp.
- **Đăng nhập lần đầu từ chính IP sẽ chạy agent** — nhảy IP giữa máy nhà và VPS rất dễ bị checkpoint.
- Tham gia hàng chục nhóm trong thời gian ngắn tự nó đã là tín hiệu spam, kể cả khi chưa đăng gì.

Khi phát hiện checkpoint/captcha, agent **ngắt cầu dao và dừng hẳn**, không tự thử lại. Ảnh chụp
màn hình lưu ở `FB_SCREENSHOT_DIR`. Phải tự mở Facebook kiểm tra rồi mới mở lại cầu dao bằng tay.

## Điều khiển qua Telegram

```bash
npm run telegram:chatid   # lấy chat ID sau khi đã nhắn cho bot
```

Điền `TELEGRAM_BOT_TOKEN` (lấy từ @BotFather) và `TELEGRAM_CHAT_ID` vào `.env`.
Bot chỉ nghe lệnh từ đúng chat ID này — người lạ biết token cũng không ra lệnh được.

| Lệnh | Tác dụng |
|---|---|
| `/status` | Tình trạng Zalo, Facebook, số job đang chờ |
| `/stats` | Thống kê 7 ngày (lấy từ `daily_metrics`, sống lâu hơn TTL 7 ngày của lịch sử job) |
| `/approve <mã>` | Duyệt tin đang chờ → soạn bài và xếp lịch đăng |
| `/reject <mã>` | Bỏ qua tin |
| `/edit <mã> <trường>=<giá trị>` | Sửa dữ liệu; nếu đã xếp lịch thì huỷ job chưa chạy và soạn lại |
| `/retry <mã>` | Soạn lại và xếp lịch đăng lại |
| `/pause` / `/resume` | Ngắt / mở cầu dao đăng bài |

Nếu Telegram không dùng được (ISP chặn, token hỏng), mở cầu dao bằng dòng lệnh:

```bash
npm run resume -- --status   # chỉ xem trạng thái cầu dao
npm run resume               # mở cầu dao Facebook
```

Tin cần duyệt được đẩy thẳng vào Telegram kèm nút **Duyệt / Bỏ qua**, không cần gõ lệnh.
Mã tin là 6 ký tự cuối của id, hiện sẵn trong thông báo.

## Theo dõi tình trạng

```bash
curl http://127.0.0.1:3100/health
```

Chỉ nghe localhost. Xem từ xa qua SSH tunnel:

```bash
ssh -L 3100:127.0.0.1:3100 user@vps
```

## Log & dọn dẹp đĩa

Log ghi ra `logs/app.<ngày>.<số>.log` (xoay vòng theo ngày, tự xoá file cũ hơn `LOG_RETENTION_DAYS`),
song song với in ra console như trước. Ảnh của tin đăng đã `posted`/`ignored`/`rejected` và screenshot
checkpoint mồ côi được tự dọn mỗi ngày lúc 3h15 sáng giờ VN; đĩa vượt `DISK_USAGE_WARN_PERCENT` (mặc
định 85%) thì có Telegram báo (tối đa 1 lần/ngày, không nhắn lại mỗi giờ).

```bash
npm run cleanup:images              # dọn tay ngay lập tức theo đúng điều kiện tuổi/trạng thái
npm run cleanup:images -- --force   # bỏ qua điều kiện tuổi — dùng khi đĩa sắp đầy
```

## Test pipeline chủ động (không phải ngồi đợi tin thật)

Agent **bỏ qua tin do chính bạn gửi**, nên tự nhắn vào nhóm Zalo sẽ không kích hoạt gì. Muốn test
ngay thì tiêm tin vào pipeline:

```bash
npm run inject -- --list    # xem 6 mẫu tin có sẵn
npm run inject -- 0         # tiêm mẫu "tin đăng đầy đủ"
npm run inject -- --text "Cho thuê phòng 25m2, 4tr5, Cầu Giấy, LH 0987654321"
```

Chỉ bước nhận tin từ Zalo được thay thế. Toàn bộ phần sau (Gemini → confidence gate → soạn bài →
xếp lịch → đăng Facebook) chạy y hệt hàng thật. Agent phải đang chạy `npm run dev`.

## Theo dõi khi chạy thật

```bash
npm run check:stuck        # chỉ in ra thứ BẤT THƯỜNG (mặc định ngưỡng 6 giờ)
npm run check:stuck 2      # nghiêm hơn: coi là kẹt nếu quá 2 giờ
```

Tìm tin nằm mãi ở trạng thái giữa chừng, job thất bại, lần đăng không rõ kết quả, cầu dao ngắt.
Không có gì bất thường thì in đúng một dòng "MỌI THỨ BÌNH THƯỜNG". Cách xử lý từng loại: [RUNBOOK.md](RUNBOOK.md).

## Sao lưu phiên đăng nhập

Phiên Zalo và hồ sơ trình duyệt Facebook là dữ liệu quan trọng nhất trên đĩa — mất là phải đăng nhập
tay lại, mà đăng nhập Facebook từ IP mới rất dễ dính checkpoint.

```bash
npm run backup:sessions   # lưu vào data/session-backups/ (giữ 5 bản gần nhất)
```

Chạy tự động sau **mỗi lần đăng nhập thành công** và **Chủ nhật hàng tuần**. Bản sao đã loại bỏ cache
của Chrome nên chỉ ~5MB thay vì ~220MB.

> Bản sao vẫn nằm trên chính VPS — nhớ copy ra ngoài định kỳ, vì mất VPS là mất luôn cả bản sao.
> Cách khôi phục: xem [RUNBOOK.md](RUNBOOK.md).

## Chạy nền trên VPS

```bash
sudo cp deploy/sale-room-agent.service /etc/systemd/system/   # sửa User/WorkingDirectory trước
sudo systemctl daemon-reload && sudo systemctl enable --now sale-room-agent
```

Hoặc dùng pm2 nếu không có quyền root: `pm2 start deploy/ecosystem.config.cjs`

> Chỉ dùng **một** trong hai. Chạy cả hai sẽ có hai tiến trình cùng mở một phiên Zalo và liên tục
> đá nhau ra (zca-js chỉ cho phép một phiên web mỗi tài khoản).

## Lưu ý vận hành

- **Chỉ một kết nối Zalo Web mỗi tài khoản.** Mở Zalo trên trình duyệt khi agent đang chạy sẽ đá agent ra; khi đó cầu dao Zalo ngắt và cần đăng nhập lại.
- Cầu dao Zalo ngắt **không** làm dừng việc trích xuất/đăng bài các tin đã nằm trong MongoDB — chỉ dừng nhận tin mới.
- Lọc nguồn tin bằng `ZALO_ALLOWED_THREAD_IDS` / `ZALO_ALLOWED_SENDER_IDS` trong `.env` để bot không xử lý mọi cuộc trò chuyện cá nhân.
- Toàn bộ mốc thời gian nghiệp vụ tính theo `Asia/Ho_Chi_Minh`, không theo giờ hệ thống của VPS.
