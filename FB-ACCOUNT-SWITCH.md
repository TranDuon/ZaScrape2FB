# Đổi tài khoản Facebook đăng bài

Quy trình đổi tài khoản Facebook mà agent dùng để đăng bài. Áp dụng khi tài khoản hiện tại bị
chặn đăng, bị checkpoint liên tục, hoặc khi muốn chuyển sang một tài khoản có độ tin cậy cao hơn.

Vận hành sự cố: [RUNBOOK.md](RUNBOOK.md) · Kiến trúc: [plan.md](plan.md)

---

## Điều quan trọng nhất phải biết trước

**Danh tính tài khoản Facebook của agent nằm gọn trong đúng MỘT biến: `FB_BROWSER_PROFILE_DIR`.**

Không có bảng tài khoản, không có mật khẩu trong `.env`, không có tên đăng nhập ở bất kỳ đâu trong
code. `src/facebook/fbBrowser.ts` mở `chromium.launchPersistentContext(FB_BROWSER_PROFILE_DIR)` —
cookie nằm trong thư mục đó *là* tài khoản. Đổi tài khoản = trỏ biến đó sang một hồ sơ khác.

Hệ quả trực tiếp: **đây là thao tác đảo ngược được bằng một dòng sửa `.env`**, miễn là bạn không
xoá hồ sơ cũ.

---

## Ba thứ KHÔNG theo tài khoản — đọc kỹ phần này

Bản hiện tại được thiết kế cho **một tài khoản duy nhất**. Toàn bộ trạng thái Facebook nằm trong
một document singleton `app_state`, không gắn với tài khoản nào. Việc tách chúng ra theo từng tài
khoản chính là Phase 10 trong [plan.md](plan.md), chưa làm.

| Trạng thái | Ở đâu | Chuyện gì xảy ra khi đổi tài khoản |
|---|---|---|
| Cầu dao đăng bài | `app_state.circuit_breaker` | Cầu dao do tài khoản **cũ** làm ngắt vẫn chặn tài khoản **mới**. Phải tự mở bằng tay. |
| Bộ đếm bài/ngày | `app_state.daily_counters` | Tài khoản mới **thừa hưởng** số bài tài khoản cũ đã đăng hôm nay. |
| Nhịp đăng theo nhóm | `groups.last_posted_at`, `groups.posts_today_count` | Cũng thừa hưởng. |

Hai dòng cuối nghe như lỗi nhưng thực ra **có lợi, đừng reset**:

- Bộ đếm ngày thừa hưởng nghĩa là tài khoản mới không thể "xả" trọn hạn mức ngay trong ngày đầu —
  đúng thứ ta muốn với một tài khoản chưa có uy tín.
- `last_posted_at` là thuộc tính **của nhóm**, không phải của tài khoản. Nhóm vừa nhận một bài cách
  đây 10 phút thì việc bài tiếp theo đến từ tài khoản khác không làm nó bớt giống spam — thành viên
  nhóm và bộ lọc của nhóm nhìn vào cái nhóm, không nhìn vào ai đăng. Giữ nguyên khoảng cách đó.

Chỉ dòng đầu (cầu dao) là bắt buộc phải xử lý bằng tay — bước 7 bên dưới.

---

## Quy trình

Toàn bộ chạy trên máy đang giữ hồ sơ trình duyệt. **Dừng agent trước khi bắt đầu** (`Ctrl+C` ở
`npm run dev`, hoặc `systemctl stop sale-room-agent` / `pm2 stop sale-room-agent` trên VPS): Chrome
khoá hồ sơ khi đang mở, và sửa `.env` giữa chừng làm `tsx watch` khởi động lại nửa vời.

### 1. Sao lưu hồ sơ hiện tại — làm TRƯỚC, không phải sau

```bash
npm run backup:sessions
```

`backupSessions()` chỉ chép đúng thư mục mà `FB_BROWSER_PROFILE_DIR` đang trỏ tới. Sau khi đổi
biến đó, mọi bản sao lưu tự động hàng tuần sẽ là của **tài khoản mới** — tài khoản cũ chỉ còn sống
trong các bản chụp tạo trước lúc đổi. Mà `SESSION_BACKUP_KEEP=5` xoay vòng xoá bản cũ, nên sau vài
tuần bản chụp cuối cùng của tài khoản cũ sẽ bị xoá mất.

Nếu còn muốn quay lại tài khoản cũ về sau, **chép bản sao lưu đó ra ngoài vòng xoay**:

```bash
cp -r data/session-backups/<ban-moi-nhat> ~/fb-account-cu
```

### 2. Tạo hồ sơ mới bằng một thư mục MỚI, không đăng xuất hồ sơ cũ

Sửa `.env`:

```diff
-FB_BROWSER_PROFILE_DIR=./data/fb-browser-profile
+FB_BROWSER_PROFILE_DIR=./data/fb-browser-profile-2
```

Không cần `mkdir` — Playwright tự tạo.

Vì sao dùng thư mục mới thay vì đăng xuất rồi đăng nhập lại vào thư mục cũ:

- **Đảo ngược được tức thì.** Tài khoản mới cũng bị chặn thì chỉ cần sửa lại một dòng, không phải
  khôi phục từ bản sao lưu.
- **`npm run login:facebook` tự thoát sớm nếu hồ sơ đã đăng nhập** (`scripts/login-facebook.ts`
  gọi `checkSession` trước rồi in "Đã đăng nhập sẵn"). Dùng lại thư mục cũ thì phải tự vào đăng
  xuất bằng tay trước, thừa một bước dễ quên.
- **Không trộn dấu vết hai tài khoản trong một hồ sơ.** Chrome giữ lịch sử, localStorage và device
  id trong đó; hai tài khoản dùng chung một hồ sơ là một liên kết rõ ràng giữa chúng dưới mắt
  Facebook.

### 3. Bật chế độ có giao diện

```diff
-FB_HEADLESS=true
+FB_HEADLESS=false
```

`login:facebook` từ chối chạy khi `FB_HEADLESS=true` — không nhìn thấy trình duyệt thì không đăng
nhập tay được. **Nhớ đặt lại `true` ở bước 5**, nếu không mỗi lần đăng bài sẽ bật một cửa sổ Chrome
hiện lên trên màn hình.

### 4. Đăng nhập tay

```bash
npm run login:facebook
```

Một cửa sổ Chrome mở ra. **Tự đăng nhập trong đó** — agent cố ý không bao giờ gõ tài khoản/mật khẩu:
tự động điền là hành vi Facebook soi kỹ nhất, và cất mật khẩu trong `.env` là rủi ro không đáng đổi.
Có hỏi mã xác minh thì cứ hoàn tất bình thường trong cửa sổ đó.

Script hỏi lại 5 giây một lần, chờ tối đa 10 phút. Vào được trang chủ là nó tự nhận ra, đóng trình
duyệt, và **tự chạy `backupSessions()` ngay** — đây là lúc hồ sơ sạch nhất (trình duyệt vừa đóng
hẳn, không có file SQLite nào đang ghi dở) và cũng là lúc nó quý nhất.

### 5. Tắt giao diện lại

```diff
-FB_HEADLESS=false
+FB_HEADLESS=true
```

### 6. Hạ hạn mức xuống mức tài khoản mới

**Đây là bước hay bị bỏ qua nhất, và bỏ qua nó là cách nhanh nhất để tài khoản mới bị chặn y hệt
tài khoản cũ.** `MAX_POSTS_PER_DAY` hiện tại được nâng dần theo uy tín tích luỹ của tài khoản cũ.
Tài khoản mới bắt đầu lại từ số không — cho nó chạy ngay ở sản lượng của tài khoản đã có uy tín là
tự chuốc checkpoint.

Đề xuất tuần đầu: **3–5 bài/ngày**, rồi nâng dần nếu không có cảnh báo nào.

Và phải tính lại cả chuỗi, vì các số này ràng buộc nhau (xem CLAUDE.md, mục "The funnel is capped
at intake"):

```
Σ per-thread caps                          = số tin nạp vào
MAX_POSTS_PER_DAY / MAX_GROUPS_PER_LISTING = số tin được soạn
số tin được soạn × MAX_GROUPS_PER_LISTING  = số bài đăng ra
```

Hạ `MAX_POSTS_PER_DAY` mà quên hạ `LISTINGS_PER_THREAD_OVERRIDES` thì Gemini vẫn trích xuất và soạn
đủ số tin như cũ, chỉ để chúng nằm chờ trong `post_jobs` không bao giờ được đăng — vừa tốn quota,
vừa phình collection (`pending` không có TTL).

### 7. Mở cầu dao

```bash
npm run resume -- --status   # xem đang ngắt vì gì
npm run resume               # mở
```

Cầu dao **không bao giờ tự mở**, kể cả khi đã đổi tài khoản — nó không biết gì về tài khoản, nó chỉ
biết "lần đăng gần nhất đã bị Facebook chặn".

Trước khi mở: **tự mở Facebook bằng tài khoản mới và kiểm tra xem nó vào nhóm, mở được ô soạn bài
bình thường không.** Mở cầu dao trong lúc còn bị hạn chế là cách nhanh nhất biến một chặn tạm thời
thành khoá tài khoản.

### 8. Kiểm chứng trước khi bật tự động

```bash
npm run seed:groups -- list                       # lấy id nhóm
npm run test:fbpost -- <id-nhóm> --dry-run        # đi hết mọi bước, KHÔNG bấm Đăng
```

Dry-run này gọi thẳng `attachImages` / `usableImagePaths` / `verifyComposedText` của luồng
production, nên nó là bằng chứng thật chứ không phải bản mô phỏng.

Sạch rồi thì đăng thật một bài vào một nhóm ít rủi ro:

```bash
npm run test:fbpost -- <id-nhóm>
```

Rồi mới `npm run dev` (hoặc khởi động lại service).

---

## Tài khoản mới phải đã là thành viên của các nhóm

`postToGroup` mở thẳng `group.url` rồi gọi `findRequired(page, "openComposer")`. Nhóm mà tài khoản
chưa tham gia thì **không có ô "Bạn viết gì đi"**, và lỗi ném ra là `SelectorNotFoundError` với lời
nhắn "Facebook nhiều khả năng đã đổi giao diện — cần cập nhật src/facebook/fbSelectors.ts".

Lời nhắn đó sai hoàn toàn trong tình huống này. Nếu ngay sau khi đổi tài khoản mà thấy lỗi selector
hàng loạt, **hãy nghi ngờ tư cách thành viên trước, đừng đi sửa selector**.

Lấy danh sách URL để đối chiếu:

```bash
npm run seed:groups -- list
```

Nhóm nào tài khoản mới chưa vào thì hoặc xin vào (chờ duyệt), hoặc tắt tạm:

```bash
npm run seed:groups -- toggle <id>
```

---

## Các job đang chờ sẽ đăng bằng tài khoản mới

`post_jobs` ở trạng thái `pending` mang sẵn bản chụp `payload.composed_text` cố định từ lúc soạn.
Chúng không gắn với tài khoản nào, nên sau khi đổi, tài khoản mới sẽ đăng đúng những nội dung đó.

Thường thì đây là điều mong muốn — không mất bài nào. Nhưng nếu tài khoản cũ bị chặn giữa chừng và
bạn nghi có bài đã lên rồi mà chưa ghi nhận được, hãy kiểm tra trước khi mở cầu dao:

```bash
npm run check:stuck
```

Bản ghi `post_history` ở trạng thái `unknown` nghĩa là **không ai biết bài đó đã lên hay chưa** —
phải tự mở nhóm ra nhìn, không được đoán. Đăng lại cùng một nội dung vào cùng một nhóm là dấu hiệu
bot không thể chối cãi và không thể thu hồi.

---

## Quay lại tài khoản cũ

Nếu hồ sơ cũ vẫn còn nguyên trên đĩa: sửa `FB_BROWSER_PROFILE_DIR` về `./data/fb-browser-profile`,
khởi động lại. Hết.

Nếu đã xoá, khôi phục từ bản sao lưu:

```bash
cp -r data/session-backups/<ban-chup>/fb-browser-profile ./data/fb-browser-profile
```

Cookie có thể đã hết hạn — nếu vậy quay lại bước 3–4 với chính thư mục đó.

---

## Đừng chép hồ sơ từ máy này sang máy khác

Hồ sơ đăng nhập từ IP nhà mà đem sang VPS chạy là một trong những cách chắc chắn nhất để ăn
checkpoint: cùng một cookie đột nhiên phát yêu cầu từ một dải IP máy chủ ở nơi khác.

Với VPS, **đăng nhập lại từ đầu ngay trên VPS** (Xvfb + VNC, xem phần A4 của kế hoạch Phase 10
trong [plan.md](plan.md)), để yêu cầu xác thực đầu tiên của hồ sơ đến từ đúng IP sẽ chạy agent về
sau.
