# Kế hoạch: Agent tự động Zalo → MongoDB → Facebook (đăng bài sale phòng trọ)

## Context

Đây là dự án cá nhân (single user), khởi tạo từ đầu. Mục tiêu: tự động hóa toàn bộ quy trình hiện đang làm thủ công — đọc tin nhắn Zalo báo phòng trọ cần đăng, tự tay soạn bài, tự tay đăng vào từng group Facebook. Agent sẽ: (1) lắng nghe tin nhắn từ Zalo cá nhân, (2) dùng LLM trích xuất thông tin phòng trọ thành dữ liệu có cấu trúc, (3) lưu tập trung vào MongoDB, (4) dùng LLM soạn nội dung bài đăng, (5) tự động đăng vào danh sách Facebook Group đã cấu hình sẵn (nơi user chỉ là thành viên, không phải admin).

Ràng buộc nền tảng đã thống nhất qua các lượt trao đổi:
- Không có API chính thức cho cả Zalo cá nhân lẫn đăng bài vào FB Group không tự quản trị → bắt buộc dùng thư viện reverse-engineered (`zca-js`) và browser automation (Playwright). User đã được cảnh báo về rủi ro ToS/khóa tài khoản và **chủ động chọn** hướng full-auto này; kế hoạch tập trung vào các cơ chế kỹ thuật giảm rủi ro (rate limit, circuit breaker) chứ không lặp lại cảnh báo.
- Quy mô cá nhân → ưu tiên đơn giản, một service Node.js/TypeScript chạy nền, không multi-tenant, không message broker riêng.
- MongoDB thay cho SQLite — hosting: **MongoDB Atlas free tier**.
- Nơi chạy hệ thống 24/7: **VPS thuê ngoài**, chạy **headless** (không cần màn hình/GUI) — Playwright chạy `headless: true`, không cần Xvfb trừ khi cần debug trực quan một lần.

## Kiến trúc tổng quan

```
Zalo (zca-js listener)
        → messageParser: chữ / ảnh / bỏ qua  (đính kèm KHÔNG BAO GIỜ thành "chữ")
        → messageBatcher: tách phòng theo TIN CHỮ, ảnh nối vào phòng đang mở
        → listings(status=received) + ảnh xuống đĩa [MongoDB Atlas]
        → extraction worker — gom tới 5 tin vào MỘT lần gọi Gemini → parsed / needs_review
        → (nếu needs_review) user duyệt qua Telegram bot → ready
        → composer worker — gom tới 3 phòng vào MỘT lần gọi Gemini
                          → queued + tạo post_jobs cho từng group active
        → scheduler (node-cron, mỗi 1-2 phút, 1 job/tick) → posting worker
        → Playwright (persistent context, VPS headless) đăng vào group FB
        → post_history + circuit breaker nếu gặp checkpoint/captcha
        → Telegram notifier báo mọi mốc quan trọng
```

Hai nhịp độ cố ý khác nhau: **thu nhận thì tức thì** (tin Zalo + ảnh vào DB ngay, không chờ gì), **gọi LLM thì gom lô** (chờ tối đa 5 phút để nhét nhiều tin vào một request). Nhờ vậy Gemini hỏng hay hết hạn ngạch cũng không làm mất dữ liệu Zalo — tin và ảnh đã nằm sẵn trong DB/đĩa, chỉ chờ chạy tiếp.

Stack: Node.js + TypeScript (chạy trực tiếp bằng `tsx`, không cần build step), MongoDB driver thuần (không dùng Mongoose — validate bằng `zod` ở tầng ứng dụng), `zca-js`, `playwright`, `node-cron`, `node-telegram-bot-api`, `@google/genai`. Chạy nền bằng `pm2` hoặc `systemd` trên VPS — không có cửa sổ/màn hình nào hiện ra.

## Cấu trúc thư mục dự án

```
sale-room-agent/
├── package.json / tsconfig.json / .env.example / .env (gitignored) / .gitignore
├── data/                          # gitignored — session & state persistence
│   ├── zalo-session/              # cookie/credentials zca-js
│   └── fb-browser-profile/        # Playwright persistent context (user data dir)
├── logs/                          # gitignored
├── src/
│   ├── index.ts                   # entrypoint: khởi động listener + scheduler
│   ├── config/{env.ts, constants.ts}
│   ├── db/{mongoClient.ts, collections.ts, indexes.ts}
│   ├── models/{listing,group,job,postHistory,appState,dailyMetrics}.model.ts
│   ├── zalo/{zaloClient.ts, messageListener.ts, mediaDownloader.ts, reconnectManager.ts}
│   ├── llm/{geminiClient.ts, extractor.ts, extractor.schema.ts, composer.ts, composer.prompts.ts, confidenceGate.ts}
│   ├── jobs/{jobQueue.ts, extractionWorker.ts, composerWorker.ts, postingWorker.ts, staleJobReaper.ts}
│   ├── facebook/{fbBrowser.ts, fbPoster.ts, fbSelectors.ts, checkpointDetector.ts, rateLimiter.ts}
│   ├── scheduler/{cronRunner.ts, scheduleLogic.ts}
│   ├── notifier/{telegramBot.ts, notifyEvents.ts}
│   ├── review/reviewFlow.ts
│   ├── health/healthServer.ts             # HTTP health check endpoint đơn giản
│   └── utils/{logger.ts, delay.ts, retry.ts, shutdown.ts}
├── scripts/{login-zalo.ts, login-facebook.ts, seed-groups.ts, backup-sessions.ts, cleanup-images.ts}
└── test/
    ├── unit/{confidenceGate.test.ts, scheduleLogic.test.ts, rateLimiter.test.ts, batchingLogic.test.ts, checkpointDetector.test.ts}
    ├── integration/{jobQueue.test.ts}
    ├── extractor.manual.ts
    └── fixtures/sample-messages.json
```

`scripts/login-zalo.ts` và `scripts/login-facebook.ts` chạy tay một lần (cần QR/2FA tương tác), session lưu vào `data/`, các module khác chỉ load lại session đã có.

## Schema MongoDB (database `sale_room_agent` trên Atlas)

**`listings`** — entity trung tâm, đi qua toàn bộ state machine. Field chính: `source` (thread/sender Zalo), `raw_message`, `images[]` (lưu local filesystem, không dùng GridFS — đơn giản hơn cho quy mô cá nhân), `is_listing` + `is_listing_reason` (kết quả phân loại "có phải tin đăng phòng không"), `parsed_data`, `confidence_score`, `missing_required_fields`, `extraction_meta`, `composed_post`, `status` (enum bên dưới), `status_history`, `review`, `target_group_ids`, timestamps.

`parsed_data` — dựa trên mẫu tin nhắn thực tế (heading dạng "Nội thất:", "Dịch vụ:", "Lưu ý:" + emoji bullet):
- Cơ bản: `title, price_vnd, area_m2, address{raw, ward, district, city}, room_type, deposit_vnd, available_from, contact_phone, contact_name`
- `furniture: { summary: string | null, items: string[] }` — nội dung mục "Nội thất"
- `utilities: { electricity_price: string|null, water_price: string|null, wifi_price: string|null, service_fee: string|null, service_fee_unit: "per_person"|"flat"|null }` — lưu dạng string gốc (vd "4000/kWh", "35k/khối", "250k/người/tháng") thay vì ép số cứng, vì đơn vị tin nhắn không đồng nhất (đ/k/tr, theo khối/theo người) — tránh sai lệch khi LLM ép kiểu số nhầm
- `house_rules: { deposit_terms: string|null, pet_allowed: boolean|null, vehicle_limit: string|null, foreigner_allowed: boolean|null, visit_notice_minutes: number|null, other_rules: string[] }` — mục "Lưu ý"
- `amenities: string[]`, `notes: string|null`, `extra: object` (catch-all)

Index:
- `{status:1, created_at:1}` — worker quét theo trạng thái
- `{"source.thread_id":1, "source.message_ids":1}` — **unique + partial**: `{ unique: true, partialFilterExpression: { "source.message_ids.0": { $exists: true } } }`. Lý do bắt buộc dùng partial: `message_ids` là array → đây là multikey index; nếu 2 listing cùng có `message_ids: []` rỗng (case ảnh đến trước khi có text) thì MongoDB index cả hai thành `null` và báo duplicate key **sai**. `partialFilterExpression` loại các doc mảng rỗng khỏi index, tránh bẫy này.
- `{created_at:-1}` — hiển thị mới nhất

**`groups`** — danh sách FB Group cấu hình: `name, url, active, post_frequency{max_posts_per_day, min_interval_minutes}, last_posted_at, posts_today_count, notes`. Index `{active:1}`.

**`post_jobs`** — hàng đợi công việc chung (extract_listing / compose_post / post_to_group), field: `type, status, payload{listing_id, group_id, composed_text}, attempts, attempt_seq, max_attempts, idempotency_key, last_error, scheduled_at, claimed_at, claimed_by, timestamps`.
Index:
- `{status:1, scheduled_at:1, type:1}` — claim atomic qua `findOneAndUpdate`
- `{idempotency_key:1}` — **unique + partial**: `{ unique: true, partialFilterExpression: { status: { $in: ["pending","claimed","processing"] } } }`. Chỉ ràng buộc trên job **chưa kết thúc** → chặn composer tạo job trùng khi chạy lại, nhưng vẫn cho phép `/retry` tạo job mới sau khi job cũ đã `failed`/`done`. `idempotency_key = hash(type + listing_id + group_id + attempt_seq)`, `attempt_seq` tăng mỗi lần retry thủ công.
- **TTL**: `{finished_at: 1}` với `expireAfterSeconds: 604800` (**7 ngày**) — chỉ áp dụng cho job đã kết thúc (`finished_at` chỉ được set khi `done`/`failed`/`cancelled`, job đang chạy có `finished_at: null` nên không bị TTL xóa nhầm).

**`post_history`** — audit trail mọi lần đăng: `listing_id, group_id, job_id, status, fb_post_url, error_message, screenshot_path, duration_ms, posted_at`.
`status` là field **duy nhất** mô tả kết quả (đã gộp, không còn field `result` riêng): `attempting | success | failed | checkpoint_blocked | skipped`. Ghi `attempting` **trước** khi Playwright bắt đầu đăng, update thành trạng thái cuối sau khi hoàn tất; nếu crash giữa chừng, stale reaper thấy `attempting` quá lâu → notify thay vì tự động retry (tránh đăng trùng bài).
Index: `{group_id:1, posted_at:-1}` (tính rate limit), `{listing_id:1}`, `{status:1, posted_at:1}` (stale reaper quét `attempting`), **TTL** `{posted_at:1}` với `expireAfterSeconds: 604800` (**7 ngày**).

**Lưu ý về TTL 7 ngày** (giữ Atlas M0 512MB không đầy): rate limit chỉ cần dữ liệu vài giờ gần nhất nên không ảnh hưởng; nhưng số liệu thống kê dài hạn phải được **tổng hợp sang `daily_metrics` trước khi bị xóa** — `daily_metrics` lưu số đếm theo ngày (vài chục byte/ngày), không đặt TTL, để `/stats` vẫn xem được lịch sử xa. Screenshot lỗi (`screenshot_path`) cũng nên được cleanup script xóa cùng nhịp 7 ngày để file không mồ côi trên disk.

**`app_state`** — 1 document singleton (`_id:"singleton"`): `circuit_breaker{tripped, reason, resume_requires_manual_ack}`, `zalo_circuit_breaker{tripped, reason, last_disconnect_at, reconnect_attempts}`, `daily_counters{date, total_posts_today}`, `zalo_session{connected, last_message_at,...}`, `fb_session{logged_in,...}`. Trường `daily_counters.date` là chuỗi ngày format theo **`Asia/Ho_Chi_Minh`** (xem mục Scheduler) — không dùng `toISOString()` của UTC.

**`daily_metrics`** — số liệu tổng hợp theo ngày, mỗi ngày 1 document `_id: "2026-08-18"` (khóa theo giờ VN): `listings_received, listings_ignored, posts_success, posts_failed, avg_extraction_time_ms, avg_posting_time_ms`. **Không đặt TTL** — đây là nơi thống kê sống sót sau khi `post_jobs`/`post_history` bị TTL 7 ngày dọn đi (chi tiết ở mục Monitoring).

## State machine của `listing`

```
received → extracting → parsed ──┬─(is_listing=false)──→ ignored (dừng, không notify ồn ào)
                                   └─(is_listing=true)──→ (Confidence Gate) → needs_review → (duyệt/Telegram) → ready
                                                              └──────────────→ ready (đủ field bắt buộc + confidence cao)
ready → queued (composer đã sinh nội dung + tạo post_to_group job cho mỗi group active)
queued → posting → posted (≥1 group thành công) | failed (tất cả group fail/circuit breaker)
```
Trạng thái phụ: `rejected` (user từ chối qua Telegram), `duplicate` (trùng thread+nội dung), `ignored` (không phải tin đăng phòng).

**Đường quay ngược `queued → ready` (re-compose sau khi `/edit`)**: nếu user sửa `parsed_data` qua Telegram khi listing đã ở `queued` (nội dung đã sinh, job đăng đang chờ) → hủy toàn bộ `post_jobs` type=`post_to_group` còn `pending` của listing đó (set `status: cancelled`), đưa listing về `ready`, enqueue lại `compose_post`. Các group **đã đăng thành công rồi thì không đụng tới** (bài đã lên FB, sửa DB không rút lại được) — bot báo rõ trong tin nhắn xác nhận: "Đã cập nhật, sẽ áp dụng cho N group còn lại; M group đã đăng trước đó giữ nguyên nội dung cũ".

**Bước phân loại (is_listing)** — cùng 1 lần gọi Gemini với extraction (không tách call riêng để tiết kiệm chi phí/độ trễ): prompt yêu cầu LLM trả thêm `is_listing: boolean` + `is_listing_reason`. Mục đích: lọc các tin nhắn không phải tin đăng phòng (banner khuyến mãi ghim đầu chat kiểu "Chính sách thưởng T8", tin nhắn xã giao, hỏi đáp không có thông tin phòng...) — các tin này chuyển thẳng `ignored`, không tạo job compose, không làm phiền Telegram, giữ DB sạch.

Confidence Gate (chỉ áp dụng khi `is_listing=true`): chỉ còn MỘT điều kiện chặn — `confidence_score < CONFIDENCE_THRESHOLD` (default 0.7) → `needs_review`, ngược lại `ready`.

**Ràng buộc field bắt buộc đã được BỎ** (bản đầu yêu cầu có `price_vnd` + địa chỉ + liên hệ). Lý do: tin Zalo thật hiếm khi đủ cả ba trong cùng một tin, giữ ràng buộc thì phần lớn tin thật bị chặn chờ duyệt tay — đúng thứ mà tự động hoá sinh ra để tránh. Riêng `contact` còn vô nghĩa ngay từ đầu: `resolveContact()` LUÔN ghi đè bằng `AGENT_CONTACT_NAME`/`AGENT_CONTACT_PHONE` (người dùng đăng lại tin của người khác kèm số của mình), nên chặn tin vì thiếu một field sẽ bị vứt đi ở bước sau là chặn nhầm hoàn toàn — đã gặp thật: một tin đăng hợp lệ kẹt ở `needs_review` với lý do "Thiếu thông tin bắt buộc: contact".

`missing_required_fields` vẫn được tính và lưu (cho `price_vnd`/`address`) để hiện trong `/status`, chỉ là không dùng để chặn nữa. Ngưỡng confidence gánh vai trò chất lượng, và làm tốt: tin gộp nhiều phòng nhiều địa chỉ trả confidence ~0.2 → tự rơi vào `ignored`.

### Idempotency & Deduplication

Xử lý trùng lặp và đảm bảo idempotency ở nhiều tầng:
- **Tầng Zalo ingest**: khi insert listing, nếu trùng unique index `{source.thread_id, source.message_ids}` → **skip** nếu status đã qua `received`; **merge** (append ảnh mới) nếu listing vẫn đang `received` (case ảnh đến trễ sau batching window).
- **Tầng batching**: dùng lock nhẹ (in-memory `Map<senderId, batchTimer>`) để tránh race condition khi 2 message burst gần nhau từ cùng sender tạo 2 listing trùng.
- **Tầng posting (quan trọng nhất)**: ghi `post_history(status=attempting)` **trước** khi Playwright bắt đầu thao tác đăng → update `success`/`failed` sau khi xong. Nếu process crash giữa chừng, stale reaper phát hiện record `attempting` quá lâu → **notify Telegram để user kiểm tra thủ công** thay vì tự động retry (vì bài có thể đã đăng thành công trên FB rồi). Chỉ retry khi user xác nhận qua `/retry <id>`.
- **Tầng job queue**: `findOneAndUpdate` claim atomic đã đảm bảo không xử lý trùng job; bổ sung `idempotency_key = hash(type + listing_id + group_id + attempt_seq)` với unique index **partial** (chỉ ràng buộc trên job `pending`/`claimed`/`processing`) → composer chạy lại không tạo job trùng, nhưng `/retry` thủ công vẫn tạo được job mới nhờ `attempt_seq` tăng lên. Không dùng unique index toàn phần vì sẽ chặn luôn retry hợp lệ.

## Workflow chi tiết theo module

1. **Zalo Listener** (event-driven, chạy liên tục): nhận tin → gom thành batch theo **cấu trúc tin nhắn** → tải ảnh về `data/` → insert `listings(status=received)` → enqueue job `extract_listing`.
   - **Ranh giới giữa hai phòng là TIN CHỮ, không phải khoảng lặng thời gian.** Gặp tin chữ → chốt batch đang mở, mở batch mới. Gặp tin ảnh → nối vào batch đang mở.
   - Lý do đổi khỏi cách gom theo thời gian (bản kế hoạch ban đầu: im lặng 30-60s thì chốt): đo trên dữ liệu thật đã lưu trong MongoDB — **149 tin nhắn trong ~4 phút, 20 tin chữ + 129 ảnh, xen kẽ đều đặn `1 chữ + N ảnh` lặp lại 20 lần**. Gom theo thời gian cho ra ĐÚNG 1 listing chứa cả 20 phòng dùng chung 1 thư mục ảnh; Gemini trả `is_listing: false` ("gộp nhiều phòng ở nhiều địa chỉ") và toàn bộ 20 phòng thật bị mất. Người đăng dội cả kho phòng trong vài phút là hành vi bình thường của môi giới, không phải ngoại lệ hiếm.
   - **Tin chữ NGẮN có phải ranh giới phòng hay không quyết định bởi "batch đang mở đã có ảnh chưa", không phải bởi độ dài.** Ngưỡng `LABEL_MAX_LENGTH = 80` ký tự chỉ nhận ra tin ngắn (tin đầy đủ ~295 ký tự, nhãn ~11); còn xử lý thế nào thì phụ thuộc ngữ cảnh, vì dữ liệu thật có hai hình dạng cần đối xử ngược nhau:
     - `[chữ đầy đủ][ảnh…][nhãn ngắn][ảnh…]` — nhãn LÀ phòng mới → chốt batch cũ.
     - `[chữ đầy đủ][chữ ngắn][ảnh…]` — chữ ngắn là lời nhắn thêm về chính phòng vừa đăng → **nối vào batch đang mở, KHÔNG chốt**.
   - Sự cố thật 23/08/2026 do thiếu phân biệt trên: người gửi nhắn tin phòng → một tin ngắn → rồi mới loạt ảnh. Tin ngắn chốt mất batch lúc nó còn 0 ảnh, rồi chính nó cũng bị bỏ (nhãn phòng không mở batch mới), nên **toàn bộ 20 ảnh gửi sau đó rơi vào hư không**. Dấu hiệu nhận ra trong MongoDB: `created_at` nằm TRƯỚC `raw_message.received_at` — batch bị chốt tức thì chứ không phải theo idle window 45s.
   - Nhãn phòng ngắn khi KHÔNG có batch nào đang mở thì vẫn bị bỏ, kéo theo ảnh đi sau nó (`addImage` bỏ ảnh mồ côi). Đây là quyết định có chủ đích — nhãn trần không có địa chỉ thì bài đăng sinh ra vô dụng — nhưng vẫn là một đường mất dữ liệu, nên **ghi log mức WARN** để nhìn thấy được khi nó xảy ra.
   - Ảnh đến TRƯỚC khi có chữ → tin chữ ngay sau đó được nối vào cùng batch, không cắt thành batch chỉ-ảnh và batch chỉ-chữ.
   - **Tin đính kèm KHÔNG BAO GIỜ được phân loại thành `kind: "text"`** (`messageParser.ts`). Vì tin chữ là ranh giới phòng, một tấm ảnh bị đọc nhầm thành chữ sẽ chốt mất batch đang mở, và vì `title` của ảnh chỉ là tên file (ngắn hơn ngưỡng nhãn) nên nó bị bỏ luôn cùng mọi ảnh phía sau. Nhận dạng ảnh vì vậy có **ba đường độc lập** — `msgType`, URL `hd`/`normal`/`origin` trong `params`, đuôi file ảnh trong URL — và khi cả ba đều trượt thì trả `kind: "other"` (bỏ qua vô hại), tuyệt đối không phải `text`. Nhánh `title`/`description` → text chỉ dành cho thẻ link/recommend.
   - Thư mục ảnh lấy theo `messageIds[0]` nên mỗi phòng tự động có thư mục riêng. Tên này khó tra bằng mắt, nên sau khi trích xuất xong `mediaDownloader.relocateListingImages()` đổi tên thư mục sang `<địa chỉ đã làm sạch>-<6 ký tự cuối listingId>` và ghi lại `images[].local_path` trong cùng lệnh cập nhật ghi `parsed_data`. Tin `ignored`/không có địa chỉ giữ nguyên tên cũ; đổi tên thất bại chỉ ghi WARN chứ không làm hỏng bước trích xuất.
   - Hai mốc thời gian (idle window, hard cap) vẫn giữ nhưng nay chỉ là lưới an toàn: chốt batch cuối khi không còn tin chữ nào tới nữa, và tránh batch mở vô hạn.
   - Nếu ảnh đến mà không có text đi trước trong window (hiếm, nhưng có thể xảy ra) → vẫn tạo listing với `raw_message.text` rỗng, để extraction cố suy luận từ ảnh (Gemini vision) hoặc rơi vào `needs_review` do thiếu field bắt buộc.
   - **Reconnect & Recovery** (`reconnectManager.ts`): `zca-js` là thư viện reverse-engineered, session có thể bị kick/expired bất kỳ lúc nào. Chiến lược xử lý:
     - Bắt sự kiện `disconnect`/`error` từ zca-js → auto-reconnect với exponential backoff (1s → 2s → 4s → ... → max 5 phút).
     - Sau 5 lần reconnect thất bại liên tiếp → trip `zalo_circuit_breaker` trong `app_state` + notify Telegram khẩn: "Zalo session expired, cần login lại thủ công".
     - **Message gap detection**: lưu `last_message_at` trong `app_state.zalo_session`; sau khi reconnect thành công, so sánh timestamp hiện tại với `last_message_at` — nếu gap > 5 phút → notify: "Có thể đã miss tin nhắn trong khoảng [T1–T2], cần kiểm tra Zalo thủ công".
     - Khi `zalo_circuit_breaker.tripped = true`: các module khác (extraction, composer, posting) vẫn hoạt động bình thường với listing đã có trong DB — chỉ ngừng nhận tin mới.
2. **Extraction Worker**: poll `post_jobs`, claim atomic → gọi Gemini (vision, multi-image) sinh JSON theo `extractor.schema.ts` (zod validate), bao gồm cả `is_listing`/`is_listing_reason` → nếu `is_listing=false` set `status=ignored`, dừng, không tạo job tiếp theo; nếu `is_listing=true` tính confidence → Confidence Gate quyết định `needs_review`/`ready` → nếu `needs_review` gửi Telegram (inline keyboard Duyệt/Từ chối/Sửa); nếu `ready` enqueue `compose_post`.
   - **GOM LÔ: nhiều tin trong MỘT lần gọi Gemini** (`src/jobs/batchCollector.ts`). Hạn ngạch đếm theo **số lần gọi** mỗi ngày mỗi model, không theo token — nên nhét N tin vào một request nhân số tin xử lý được lên đúng N lần với chi phí token gần như không đổi. Worker nhận job NGAY khi thấy rồi giữ lại chờ gom thêm trong `LLM_BATCH_WINDOW_MS` (mặc định 5 phút), đủ `EXTRACTION_BATCH_SIZE` (5) thì chạy sớm. Cửa sổ 5 phút cố ý nhỏ hơn nhiều so với mốc coi job là kẹt (15 phút) để job đang gom không bị `requeueStaleJobs` hiểu nhầm.
   - **Ghép kết quả theo `index`, TUYỆT ĐỐI không theo vị trí mảng.** Model được yêu cầu chép số hiệu `=== TIN #n ===` vào từng phần tử; nơi gọi dựng `Map<index, item>` và bỏ index trùng/ngoài lô. Ghép theo vị trí sẽ hỏng lặng lẽ và rất nặng: một lần model đảo thứ tự là giá + số điện thoại của phòng này gắn sang địa chỉ phòng khác, rồi bài sai đó lên thẳng Facebook.
   - **Cô lập lỗi hai tầng** — đây là điều kiện để dám gom lô: cả lần gọi hỏng (mạng, hết hạn ngạch, JSON không đọc được) → mọi job trong lô thử lại độc lập, giữ nguyên số lượt của mình; chỉ một tin hỏng (model bỏ sót, sai schema riêng tin đó) → chỉ job đó thử lại, các tin còn lại đã ghi xong vẫn đi tiếp. Một tin xấu không được kéo theo bốn tin tốt.
   - Chữ và ảnh đi **xen kẽ** trong một mảng `parts`: ảnh của tin nào phải nằm ngay sau khối chữ của tin đó. Dồn hết chữ lên đầu rồi nối ảnh xuống cuối là cách chắc chắn nhất khiến model gán nhầm ảnh. `EXTRACTION_BATCH_MAX_IMAGES` là trần cho CẢ LÔ, chia đều cho các tin, để lô 5 tin không bắn 20 ảnh trong một request.
   - Prompt extraction cần xử lý đặc thù tin nhắn phòng trọ Việt Nam: heading theo emoji bullet ("Nội thất:", "Dịch vụ:", "Lưu ý:"), viết tắt giá tiền (k=nghìn, tr=triệu, đ), viết tắt tháng ("T8"=tháng 8) — map đúng vào `furniture`/`utilities`/`house_rules` thay vì đổ hết vào `notes`.
   - **Giới hạn ảnh gửi vào prompt**: tin nhắn thực tế thường kèm 10-15 ảnh; gửi hết vào vision request vừa tốn chi phí vừa dễ vượt giới hạn kích thước request. Chỉ gửi `MAX_IMAGES_PER_EXTRACTION` ảnh đầu (default 4) — đủ để LLM xác nhận loại phòng/nội thất — nhưng **vẫn lưu và đăng lên FB toàn bộ ảnh**. Resize ảnh xuống cạnh dài ~1024px trước khi gửi để giảm token thêm nữa.
3. **Composer Worker**: sinh `composed_post` từ `parsed_data` → set `queued` → tạo 1 job `post_to_group` cho mỗi group active, `scheduled_at` giãn cách ngẫu nhiên (group 1: +5-15p, group 2: +20-40p...).
   - **Prompt engineering** (`composer.prompts.ts`): template prompt cần quy định rõ tone & format bài đăng:
     - Phong cách: thân thiện, dùng emoji vừa phải (🏠 📍 💰), không quá formal.
     - Hashtag: tự sinh dựa trên `address.district`/`address.city` (vd: `#phongtro #quan7 #chothue #hochiminh`).
     - Cấu trúc bài: tiêu đề hấp dẫn → thông tin chính (giá, diện tích, địa chỉ) → tiện ích → liên hệ.
   - **Variation strategy (chống spam)**: khi đăng cùng 1 listing lên N group → sinh **N biến thể nội dung khác nhau** (khác câu mở đầu, thứ tự thông tin, cách diễn đạt). Đăng y hệt 1 nội dung lên nhiều group = red flag rõ ràng cho hệ thống chống spam FB.
   - **Nguồn sự thật của nội dung** (tránh mơ hồ giữa 2 nơi lưu):
     - `listing.composed_post` = **bản gốc canonical** — là thứ user xem và sửa qua Telegram, là đầu vào để sinh biến thể.
     - `post_jobs.payload.composed_text` = **snapshot bất biến** của biến thể đã gán cho group đó, chốt tại thời điểm tạo job. Posting worker luôn đăng đúng snapshot này, không đọc lại `listing` lúc đăng → bài đã lên FB khớp chính xác với thứ được duyệt.
     - Khi user `/edit` lúc listing đang `queued` → hủy job `pending`, quay về `ready`, re-compose và sinh snapshot mới (xem "Đường quay ngược `queued → ready`" ở State machine).
   - Chi phí LLM: nếu N group lớn, gọi Gemini N lần tốn kém → tối ưu bằng cách gọi 1 lần với prompt "sinh 5 biến thể" rồi phân bổ ngẫu nhiên cho các group.
   - **Gom lô ở tầng thứ hai**: ngoài việc N biến thể chung một lần gọi, nhiều PHÒNG cũng đi chung một lần gọi (`composePosts`). Số bài phải viết trong một request là `COMPOSE_BATCH_SIZE × số group`, nên đây là phía dễ bị cắt cụt output nhất trong cả dự án — mặc định lô soạn bài (3) thấp hơn lô trích xuất (5). Output bị cắt = JSON hỏng = cả lô phải chạy lại, nên hai nhánh lỗi parse JSON đều ghi kèm `batch_size` và `output_length` và nêu đích danh biến cần hạ. **Không** thêm đường tự động rơi về gọi lẻ từng phòng khi lỗi — làm vậy có thể âm thầm đốt sạch hạn ngạch cả ngày.
   - `staggeredSchedule` cộng dồn mốc giãn cách **xuyên suốt cả lô** thay vì đếm lại từ 0 cho từng phòng; nếu không, soạn 3 phòng một lượt sẽ xếp cả ba bài đầu tiên vào cùng vài phút, phá đúng cái giãn cách sinh ra để tránh.
4. **Scheduler** (`node-cron`, tick mỗi 1-2 phút): nếu `circuit_breaker.tripped` → skip toàn bộ; nếu **ngoài khung giờ hoạt động** → skip; nếu vượt `MAX_POSTS_PER_DAY` → skip tới ngày mai; ngược lại lấy **đúng 1 job** đến hạn mỗi tick (tự nhiên tạo giãn cách, không cần sleep chặn event loop) → gọi Posting Worker.
   - **Khung giờ hoạt động (active hours)** — quan trọng với mục tiêu chống phát hiện bot: không ai đăng tin cho thuê phòng lúc 3h sáng đều đặn mỗi ngày; đăng rải đều 24/7 là dấu hiệu bot rõ hơn cả tần suất. Chỉ đăng trong `ACTIVE_HOURS_START`–`ACTIVE_HOURS_END` (default 7h–22h **giờ Việt Nam**), cộng jitter ±30 phút thay đổi theo ngày để biên khung giờ không cố định cứng.
   - Job có `scheduled_at` rơi ngoài khung → dời sang đầu khung giờ hôm sau (cộng jitter), không hủy.
   - **Toàn bộ tính toán ngày/giờ theo `Asia/Ho_Chi_Minh`**, không theo giờ hệ thống VPS (thường là UTC) — nếu không, `daily_counters` sẽ reset lúc 7h sáng giờ VN và `/stats` báo sai ngày. Đặt `TZ=Asia/Ho_Chi_Minh` trong `.env`/systemd, và khi sinh chuỗi `daily_counters.date` phải format theo timezone này chứ không dùng `toISOString()`.
5. **Posting Worker / FB Auto-poster**: mở Playwright persistent context (**headless: true** trên VPS, không cần GUI/màn hình) → kiểm tra đã login chưa (không tự nhập mật khẩu nếu session hỏng — trip circuit breaker + notify) → điều hướng group → điền nội dung lấy từ `post_jobs.payload.composed_text` (snapshot đã chốt, **không đọc lại `listing.composed_post`**) + upload ảnh với delay ngẫu nhiên giả lập người dùng → `checkpointDetector` kiểm tra DOM sau mỗi hành động; nếu phát hiện checkpoint/captcha: chụp screenshot, trip circuit breaker (`resume_requires_manual_ack: true`, không tự resume), notify khẩn cấp, dừng toàn bộ posting job còn lại. Nếu thành công: ghi `post_history`, cập nhật `group.last_posted_at`/`posts_today_count`, `app_state.daily_counters`.
   - Giảm dấu hiệu bot của headless: dùng `channel: "chrome"` (Chrome thật thay vì Chromium bundled) — kéo theo lệnh cài phải là `npx playwright install --with-deps chrome`, **không phải `chromium`**. Playwright bản mới đã dùng chế độ headless mới khi set `headless: true`; không viết `headless: "new"` (đó là cú pháp Puppeteer, sai kiểu trong Playwright). Nếu sau này checkpoint xảy ra thường xuyên, cân nhắc chuyển sang Xvfb + headful.
   - **Selector Abstraction Layer** (`fbSelectors.ts`): Facebook thay đổi DOM structure thường xuyên (hàng tuần/tháng). Tách toàn bộ CSS/XPath selector vào 1 file cấu hình riêng:
     - Mỗi element (nút "Tạo bài viết", ô nhập nội dung, nút "Đăng", dialog upload ảnh...) có **2-3 selector fallback**: by `aria-label`, by `data-testid`, by text content, by CSS class pattern.
     - Hàm `findElement(selectorKey)` thử từng selector theo thứ tự ưu tiên; nếu tất cả fail → chụp screenshot DOM + notify Telegram: "Selector `<key>` broken, cần update `fbSelectors.ts`" → trip circuit breaker thay vì crash loop.
     - Lưu DOM snapshot (hash) của các page quan trọng (group feed, compose dialog) vào `app_state`; so sánh trước/sau mỗi lần đăng → phát hiện sớm khi FB thay đổi cấu trúc dù selector vẫn còn hoạt động.
6. **Review Flow qua Telegram**: `/approve <id>`, `/reject <id>`, `/edit <id> <field>=<value>`, `/pause`, `/resume` (chỉ khi user chủ động xác nhận), `/status`, `/retry <id>`, `/stats` (xem thống kê nhanh: hôm nay bao nhiêu listing received/posted/failed, circuit breaker status).
   - `/edit` khi listing đã `queued` → kích hoạt luồng re-compose (hủy job pending, quay về `ready`) như mô tả ở State machine; bot phản hồi rõ số group còn lại sẽ dùng nội dung mới và số group đã đăng giữ nguyên nội dung cũ.
   - `/retry <id>` → tăng `attempt_seq`, sinh `idempotency_key` mới rồi tạo lại job (nhờ unique index partial nên không bị chặn).
7. **Stale Job Reaper** (`requeueStaleJobs` + `src/maintenance/stalePostReaper.ts`): job kẹt ở `processing` quá lâu (process crash giữa chừng) cần được dọn — bắt buộc vì listener/worker chạy chung 1 process. **Xử lý khác nhau theo loại job, đây là điểm mấu chốt chống đăng trùng:**
   - `extract_listing`/`compose_post` → reset về `pending` để chạy lại. Chạy lại chỉ tốn thêm quota Gemini, không để lại hậu quả ra bên ngoài.
   - `post_to_group` → **KHÔNG BAO GIỜ** reset về `pending`, đánh dấu `failed` và dừng hẳn. Tiến trình có thể đã chết ngay SAU khi Playwright bấm nút Đăng nhưng TRƯỚC khi `completeJob` kịp chạy → bài rất có thể đã nằm trên Facebook. Cho chạy lại là đăng trùng đúng nội dung lên đúng nhóm đó.
   - Bản ghi `post_history` treo ở `attempting` chính là bằng chứng của tình huống trên. `stalePostReaper` (mỗi 10 phút) chuyển nó sang `unknown` và báo Telegram để người dùng tự mở nhóm kiểm tra — `unknown` tách riêng khỏi `failed` vì hai thứ dẫn tới hành động khác nhau: `failed` là chắc chắn chưa đăng (đăng lại được), `unknown` là phải nhìn tận mắt trước đã.
8. **Graceful Shutdown** (`shutdown.ts`): xử lý `SIGTERM`/`SIGINT` (từ `pm2 restart`, `systemd stop`, hoặc Ctrl+C) theo trình tự:
   - Set flag `isShuttingDown = true` → scheduler ngừng pick job mới, Zalo listener ngừng xử lý message mới (vẫn buffer trong zca-js).
   - Chờ job đang chạy hoàn tất (đặc biệt posting worker) với timeout 30 giây.
   - Đóng Playwright browser context **đúng cách** (`browserContext.close()`) → tránh corrupt `fb-browser-profile/` (nếu profile bị corrupt → phải login lại Facebook thủ công = downtime lớn).
   - Đóng MongoDB connection pool.
   - Log "Shutdown complete" → `process.exit(0)`.
   - Nếu timeout 30s mà job chưa xong → force exit với `process.exit(1)`, stale reaper sẽ xử lý job dở dang khi service restart.

## Cấu hình `.env`

```
MONGODB_URI=<connection string từ Atlas>
MONGODB_DB_NAME=sale_room_agent
GEMINI_API_KEY=...
GEMINI_EXTRACTION_MODEL=gemini-3.5-flash   # model có vision (2.x đã bị Google gỡ — xem CLAUDE.md)
GEMINI_COMPOSER_MODEL=gemini-3.5-flash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
ZALO_SESSION_DIR=./data/zalo-session
ZALO_ALLOWED_SENDER_IDS=...           # optional, giới hạn thread xử lý
FB_BROWSER_PROFILE_DIR=./data/fb-browser-profile
FB_HEADLESS=true                       # bắt buộc true trên VPS — chạy ngầm, không cần màn hình
MAX_POSTS_PER_DAY=15
GROUP_MIN_INTERVAL_MINUTES=180
POST_DELAY_MIN_SECONDS=180
POST_DELAY_MAX_SECONDS=600
SCHEDULER_TICK_CRON=*/2 * * * *
CONFIDENCE_THRESHOLD=0.7
LOG_LEVEL=info
LOG_DIR=./logs                         # thư mục ghi log xoay vòng (pino-roll)
LOG_RETENTION_DAYS=7                   # giữ N file log gần nhất, file cũ hơn tự bị xoá
TZ=Asia/Ho_Chi_Minh                    # BẮT BUỘC — mọi tính toán ngày/giờ theo giờ VN, không theo UTC của VPS
ACTIVE_HOURS_START=7                   # chỉ đăng bài trong khung 7h–22h giờ VN
ACTIVE_HOURS_END=22
ACTIVE_HOURS_JITTER_MINUTES=30         # xê dịch biên khung giờ mỗi ngày, tránh pattern cố định
MAX_IMAGES_PER_EXTRACTION=4            # số ảnh tối đa gửi vào prompt Gemini (vẫn đăng đủ ảnh lên FB)
LLM_BATCH_WINDOW_MS=300000             # chờ gom thêm tin trước khi gọi Gemini; 0 = gọi ngay, không chờ
EXTRACTION_BATCH_SIZE=5                # số tin tối đa trong MỘT lần gọi trích xuất
EXTRACTION_BATCH_MAX_IMAGES=16         # trần ảnh cho CẢ LÔ, chia đều cho các tin trong lô
COMPOSE_BATCH_SIZE=3                   # thấp hơn lô trích xuất: mỗi phòng còn nhân thêm số biến thể
HEALTH_CHECK_PORT=3100                 # HTTP health check endpoint
HEALTH_CHECK_BIND=127.0.0.1            # chỉ nghe localhost — xem từ xa qua SSH tunnel
HEALTH_CHECK_TOKEN=<random string>     # bắt buộc nếu đổi bind sang 0.0.0.0
JOB_HISTORY_RETENTION_DAYS=7           # TTL cho post_jobs đã kết thúc + post_history
IMAGE_RETENTION_DAYS=30                # xóa ảnh listing cũ hơn N ngày
DISK_USAGE_WARN_PERCENT=85             # notify khi disk sắp đầy
ZALO_RECONNECT_MAX_ATTEMPTS=5          # số lần reconnect trước khi trip circuit breaker
ZALO_RECONNECT_MAX_BACKOFF_MS=300000   # max 5 phút giữa các lần retry
```

Ghi chú Atlas: cần whitelist IP tĩnh của VPS trong Atlas Network Access; dùng connection string dạng `mongodb+srv://...`. Gói M0 giới hạn **512MB** → TTL 7 ngày cho `post_jobs`/`post_history` (mục Schema) là bắt buộc, không phải tùy chọn.
Ghi chú VPS + Playwright: cài `npx playwright install --with-deps chrome` (Chrome thật, khớp với `channel: "chrome"` — không phải `chromium`); chạy headless nên không có cửa sổ hiện ra — dựa vào `checkpointDetector` + screenshot lưu lại để debug thay vì xem màn hình trực tiếp. Chạy process nền qua `pm2 start` hoặc `systemd` service để tự khởi động lại nếu crash, không cần ai đăng nhập giữ phiên terminal. Nếu dùng `systemd`, set `Environment=TZ=Asia/Ho_Chi_Minh` trong unit file.

### Security hardening

- **File permissions**: `.env` trên VPS phải `chmod 600` (chỉ owner đọc). `data/` chứa session credentials cũng tương tự.
- Ưu tiên dùng **`systemd` EnvironmentFile** thay vì `.env` file trực tiếp — `systemd` quản lý biến môi trường an toàn hơn (không hiện khi `ps aux`, không bị đọc bởi user khác trên cùng VPS).
- `TELEGRAM_CHAT_ID`: validate ở tầng `reviewFlow.ts` — chỉ xử lý command từ **đúng chat ID đã cấu hình**, ignore mọi message từ chat khác → tránh người lạ gửi `/approve` hoặc `/pause` nếu biết bot token.
- **Health endpoint không được hở ra internet**: `/health` trả về toàn bộ tình trạng vận hành (session Zalo/FB, số job, disk) — ai quét port VPS cũng đọc được. Bind `127.0.0.1` (mặc định), truy cập từ xa qua SSH tunnel: `ssh -L 3100:127.0.0.1:3100 user@vps`. Chỉ đổi sang `0.0.0.0` khi thật sự cần monitor bên ngoài (UptimeRobot), và khi đó **bắt buộc** kèm `HEALTH_CHECK_TOKEN` kiểm tra trong header/query, cộng firewall giới hạn IP nguồn.
- Backup `.env` và `data/` credentials ở nơi an toàn ngoài VPS (password manager, encrypted cloud note) — mất VPS = mất toàn bộ config + session.

## Package npm

Dependencies: `zca-js`, `playwright`, `mongodb`, `@google/genai`, `node-cron`, `node-telegram-bot-api`, `zod`, `dotenv`, `pino` (+ `pino-pretty` dev).
Dev: `typescript`, `tsx`, `@types/node`, `vitest` (unit/integration test), `mongodb-memory-server` (test jobQueue không cần Atlas thật), (tuỳ chọn) `eslint`.

## Monitoring & Observability

**Health Check HTTP Server** (`healthServer.ts`): `http.createServer` đơn giản (không cần Express), **bind `HEALTH_CHECK_BIND` = `127.0.0.1`** trên `HEALTH_CHECK_PORT` (default 3100) — không hở ra internet, xem từ xa qua SSH tunnel. Endpoint duy nhất `GET /health` trả JSON:
```json
{
  "status": "ok | degraded | down",
  "zalo": { "connected": true, "last_message_at": "..." },
  "facebook": { "logged_in": true, "circuit_breaker": false },
  "zalo_circuit_breaker": { "tripped": false },
  "jobs": { "pending": 3, "stuck": 0 },
  "today": { "listings_received": 12, "posts_success": 8, "posts_failed": 1 },
  "disk_usage_percent": 42,
  "uptime_seconds": 86400
}
```
Dùng để monitor: `curl` qua SSH tunnel (`ssh -L 3100:127.0.0.1:3100 user@vps`), hoặc script cron trên máy cá nhân. Muốn dùng dịch vụ ngoài (UptimeRobot) thì phải đổi bind sang `0.0.0.0` **kèm `HEALTH_CHECK_TOKEN`** — xem mục Security hardening.

**Metrics** — chốt lưu ở collection **`daily_metrics`** riêng (không nhét vào `app_state`, vì `app_state` là singleton state vận hành còn metrics là chuỗi theo ngày):
- Mỗi ngày 1 document: `{ _id: "2026-08-18", listings_received, posts_success, posts_failed, listings_ignored, avg_extraction_time_ms, avg_posting_time_ms }` — khóa ngày format theo `Asia/Ho_Chi_Minh`.
- **Không đặt TTL** cho collection này (mỗi doc chỉ vài chục byte). Đây là nơi số liệu sống sót sau khi `post_jobs`/`post_history` bị TTL 7 ngày xóa → `/stats` vẫn xem được xu hướng dài hạn.
- Worker cập nhật bằng `$inc` ngay khi có sự kiện, không tính lại từ `post_history` (vốn đã bị xóa sau 7 ngày).
- Telegram `/stats` query trực tiếp từ đây.

**Log rotation**: đã chọn dùng `pino-roll` transport (không dùng `logrotate` của VPS) — lý do: tự
xoay vòng ngay trong app nên hành vi giống hệt nhau giữa máy dev Windows và VPS Linux, không cần
cấu hình thêm gì ở tầng hệ điều hành. `src/utils/logger.ts` dùng `pino({transport: {targets: [...]}})`
với 2 target song song: một target `pino-roll` luôn bật (ghi `LOG_DIR/app.<yyyy-MM-dd>.<n>.log`,
xoay theo ngày, giữ `LOG_RETENTION_DAYS` file gần nhất rồi tự xoá file cũ hơn), một target console
(`pino-pretty` nếu `LOG_PRETTY=true`, ngược lại JSON thô qua `pino/file` ra stdout) — để `npm run dev`
hoặc `pm2 logs`/`journalctl` vẫn xem trực tiếp được như trước.

## Quản lý ảnh trên Filesystem

Ảnh lưu local filesystem trên VPS — cần quản lý dung lượng chủ động. Đã triển khai:
- **Retention policy**: logic thật nằm ở `src/maintenance/imageCleanup.ts` (`cleanupListingImages`),
  được `src/maintenance/cronJobs.ts` tự chạy mỗi ngày lúc 3h15 sáng giờ VN (trong app, qua
  `node-cron`, không cần crontab riêng của VPS — cùng lý do với quyết định log rotation ở trên: hành
  vi giống hệt nhau giữa dev và VPS). Xoá cả thư mục ảnh của listing có `status` ∈
  `{posted, ignored, rejected}` — đây là 3 trạng thái state machine không bao giờ quay lại — và
  `created_at` cũ hơn `IMAGE_RETENTION_DAYS` (default 30 ngày). **Cố ý KHÔNG** xoá ảnh của
  `failed`/`duplicate`: `/retry` vẫn có thể soạn lại các listing này và cần ảnh gốc. Sau khi xoá,
  listing được cập nhật lại `images[].storage = "none"` để MongoDB không còn nói dối là ảnh vẫn tồn tại.
- **Screenshot mồ côi**: `cleanupOrphanedScreenshots()` trong cùng file xoá theo tuổi file (mtime),
  không tra cứu lại `post_history` (đã bị TTL xóa sau `JOB_HISTORY_RETENTION_DAYS` nên không còn gì
  để tra), cùng lịch chạy mỗi ngày.
- **Chạy tay**: `scripts/cleanup-images.ts` là CLI mỏng gọi lại đúng 2 hàm trên, hỗ trợ `--force` để
  bỏ qua điều kiện tuổi (dùng khi đĩa sắp đầy, xem Runbook).
- **Disk usage monitoring**: `src/utils/diskUsage.ts` (`fs.statfs`, không cần thư viện ngoài, chạy
  được cả Windows dev lẫn Linux VPS) được `cronJobs.ts` gọi mỗi giờ; vượt `DISK_USAGE_WARN_PERCENT`
  (default 85%) → notify Telegram, debounce còn **1 lần/ngày** qua `app_state.disk_warning` để không
  nhắn lại mỗi giờ. `disk_usage_percent` cũng lộ ra ở `/health` và kéo status xuống `"degraded"`.
- **Graceful handling**: khi đọc `images[]` path từ DB mà file không tồn tại (đã bị xóa/cleanup) → log warning, không crash; extraction/posting skip ảnh missing thay vì fail toàn bộ job.
- **Backup cân nhắc**: nếu ảnh quan trọng (cần lưu lâu dài), cân nhắc upload lên cloud storage rẻ (Cloudflare R2 free tier 10GB, hoặc Backblaze B2) sau khi posted thành công, rồi mới xóa local.

## Backup & Disaster Recovery

| Đối tượng | Chiến lược | Tần suất |
|---|---|---|
| MongoDB Atlas | Atlas free tier **không có** automated backup → chạy `mongodump` qua cron vào lúc ít traffic (3-4 AM giờ VN, nằm ngoài khung giờ đăng bài) | Daily |
| Session files (`data/zalo-session/`, `data/fb-browser-profile/`) | **Đã làm**: `src/maintenance/sessionBackup.ts` + `scripts/backup-sessions.ts`, copy sang `SESSION_BACKUP_DIR`, giữ `SESSION_BACKUP_KEEP` bản. Bỏ qua cache của Chrome (~200MB/218MB là cache tái tạo được) nên bản sao chỉ ~4.5MB. **Đây là critical state** — mất = phải re-login thủ công (đặc biệt FB có thể trigger 2FA/checkpoint khi login từ IP mới) | Tự động sau mỗi lần login thành công + Chủ nhật 3h45 sáng |
| VPS snapshot | Snapshot toàn bộ VPS sau khi setup xong + sau mỗi lần thay đổi lớn | Manual, sau milestone |
| `.env` + config | Lưu bản copy trong password manager (Bitwarden/1Password) hoặc encrypted note | Mỗi khi thay đổi |

**Runbook** — đã viết đầy đủ thành [RUNBOOK.md](RUNBOOK.md) trong repo. Tóm tắt các tình huống:
- Zalo session expired → chạy `scripts/login-zalo.ts` trên VPS (cần forward QR qua Telegram hoặc SSH X11) → chạy `backup-sessions.ts`.
- FB checkpoint/session expired → chạy `scripts/login-facebook.ts` (cần headful tạm thời: `FB_HEADLESS=false` + Xvfb hoặc VNC) → `/resume` qua Telegram.
- VPS bị restart → `systemd`/`pm2` tự khởi động lại → kiểm tra `/health` endpoint → nếu Zalo/FB session vẫn OK thì không cần làm gì.
- MongoDB Atlas maintenance window → downtime ngắn, app retry kết nối tự động (MongoDB driver có built-in retry) → check log sau maintenance.
- Disk đầy → chạy `cleanup-images.ts --force` (bỏ qua retention, xóa tất cả ảnh đã posted) → tăng `IMAGE_RETENTION_DAYS` nếu cần.

## Chiến lược Testing

**Đã triển khai** (Phase 8) — dùng `vitest`, chạy `npm test`:
- `test/unit/confidenceGate.test.ts` — đủ field bắt buộc + confidence cao → `ready`; thiếu `price_vnd`/địa chỉ/liên hệ → `needs_review`; `is_listing=false` → `ignored` (bỏ qua trước, không xét thiếu field); kèm test chuẩn hoá dữ liệu bẩn qua `extractionSchema` (zod).
- `test/unit/scheduleLogic.test.ts` — mock `db/collections.js`, `facebook/rateLimiter.js`, `jobs/jobQueue.js`, `jobs/postingWorker.js` qua `vi.mock`: circuit breaker tripped → skip; ngoài khung giờ → skip; vượt `MAX_POSTS_PER_DAY` → skip; còn hạn mức → dọn job kẹt rồi lấy đúng 1 job.
- `test/unit/messageBatcher.test.ts` — text + ảnh cùng sender trong window → gom; người gửi khác xen giữa → tách; tin cách xa nhau dù đến dồn dập (Zalo replay) → tách; trần cứng chốt batch dù nhắn liên tục.
- `test/unit/messageParser.test.ts`, `test/unit/time.test.ts`, `test/unit/numberParser.test.ts` — phần còn lại của các smoke test cũ, migrate nguyên vẹn sang vitest.
- `rateLimiter`/`checkpointDetector`: **không** viết vitest riêng — đã có `test:facebook` (`test/facebook.smoke.ts`) phủ cả hai bằng Playwright thật + Atlas thật, giữ nguyên vì đây là bài test đã chạy thật và được xác minh, chuyển sang mock chỉ đổi hình thức chứ không tăng độ phủ.

**Giữ nguyên là script `tsx` thủ công** (không migrate sang vitest — chạm API thật, chỉ chạy tay có credential thật): `test:extractor`, `test:composer`, `test:jobqueue` (cố ý test trên Atlas thật, xem "Job queue là primitive điều phối" ở CLAUDE.md), `test:facebook`, `test:telegram`.

**Manual/E2E tests** (đã có, mở rộng thêm):
- `extractor.manual.ts` — test với tin nhắn thật + ảnh thật → verify `parsed_data` chính xác.
- Chạy full pipeline với 1 FB group test riêng (group do mình tạo, chỉ có mình là thành viên) → verify bài đăng hiện đúng nội dung + ảnh.

Chạy test: `npx vitest run` (unit + integration), `npx vitest --watch` (dev mode). CI/CD không bắt buộc cho dự án cá nhân, nhưng nên chạy test trước mỗi deploy lên VPS.

## Lộ trình triển khai theo giai đoạn

| Phase | Deliverable | Verify |
|---|---|---|
| 1. Skeleton + MongoDB Atlas — **Đã xong** | Kết nối Atlas thành công, index tạo tự động (kèm unique partial + TTL 7 ngày), timezone VN, graceful shutdown handler | `npm run dev` log "Connected"; `db.post_jobs.getIndexes()` thấy TTL `expireAfterSeconds: 604800`; log timestamp đúng giờ VN; gửi `SIGTERM` → log "Shutdown complete" |
| 2. Zalo listener + reconnect — **Đã xong**, đã sửa 3 lỗi mất dữ liệu | Đăng nhập QR, nhận tin thật, lưu `listings(received)` + ảnh, tách phòng theo tin chữ, reconnect manager hoạt động | Gửi tin phòng kèm ảnh → log `images: N` > 0 **và** có thư mục thật trong `data/images/`, KHÔNG có WARN "Ảnh đến khi không có batch nào đang mở"; `npm test` pass `messageParser`/`messageBatcher`; ngắt mạng 30s → reconnect tự động + notify |
| 3. LLM extraction — **Đã xong**, đã thêm gom lô | Worker parse tin → `parsed_data` (kèm `furniture`/`utilities`/`house_rules`), `is_listing`, confidence, routing status, giới hạn ảnh vào prompt, **gom nhiều tin vào một lần gọi** | Chạy `test/extractor.manual.ts` với case thật (12+ ảnh → verify chỉ 4 ảnh vào request) + case nhiễu; `npx vitest run` pass cho `confidenceGate.test.ts` + `llmBatch.test.ts` + `batchCollector.test.ts`; log có `batch_size` > 1 khi nhiều tin về cùng lúc |
| 4. Groups/Jobs CRUD | `seed-groups.ts`, claim job atomic, `app_state` + `daily_metrics` init, idempotency key | Chạy 2 worker song song → không xử lý trùng job; composer chạy lại → job trùng bị chặn; `/retry` sau khi job failed → tạo được job mới (không bị unique index chặn) |
| 5. Post composer + variations | Sinh nội dung bài **nhiều biến thể**, snapshot vào `payload.composed_text`, luồng re-compose khi `/edit` | Kiểm tra N biến thể khác nhau; `/edit` lúc `queued` → job pending bị cancel + listing về `ready` + sinh snapshot mới |
| 6. FB auto-poster + selectors | Đăng thật lên 1 group test (headless), selector fallback, checkpoint detect, rate limit | `login-facebook.ts` 1 lần; test từng selector fallback; test circuit breaker bằng set cờ thủ công |
| 7. Scheduler + Notifier + Health | Toàn trình tự động `received→posted`; khung giờ hoạt động 7h–22h + jitter; Telegram commands đủ (kèm `/stats`); health endpoint bind localhost | Theo dõi 1 listing chạy hết pipeline; đặt job `scheduled_at` lúc 2h sáng → verify bị dời sang đầu khung hôm sau; test `/approve /pause /resume /status /stats`; `curl` từ localhost OK, từ IP ngoài bị từ chối |
| 8. Testing + Monitoring — **Đã xong** | Unit test (vitest), log rotation (`pino-roll`), cleanup ảnh + screenshot mồ côi, disk usage monitoring | `npm test` 36/36 pass; `npx tsc --noEmit` sạch; `npx tsx scripts/cleanup-images.ts` chạy thật trên Atlas không lỗi; `/health` trả `disk_usage_percent` |
| 9. E2E + hardening + backup — **Đã xong phần code** | Stale job/post reaper (chống đăng trùng); `backup-sessions.ts` + lịch tự động; systemd/pm2 config; [RUNBOOK.md](RUNBOOK.md) | `npm run test:jobqueue` chứng minh job đăng bài KHÔNG requeue sau khi tiến trình chết; reaper quét đúng bản ghi treo và không báo trùng; `npm run backup:sessions` chạy thật: 218MB → 4.5MB, xoay vòng đúng. **Còn lại:** chạy thật vài ngày trên VPS + verify restore |
| 10. Deploy VPS + đa tài khoản Facebook — **Chưa bắt đầu, kế hoạch đã chốt** | (A) Deploy bản 1-tài-khoản lên VPS Google Cloud thật; (B) mở rộng đăng bài sang 2-3 tài khoản Facebook, route cố định theo khu vực trên nền `areaMatcher.ts` đã có — xem mục "Deploy VPS + đa tài khoản Facebook" bên dưới | A: `test:fbpost --dry-run` chạy trên chính VPS pass, `check:stuck` sạch, sống sót một lần reboot. B: ngắt cầu dao một tài khoản, xác nhận các tài khoản còn lại vẫn đăng bình thường |

## Deploy VPS + đa tài khoản Facebook (kế hoạch, chưa triển khai)

Ghi lại 2026-08-24 sau một phiên lập kế hoạch chi tiết (khảo sát kiến trúc + khảo sát mức sẵn sàng
deploy bằng subagent, sau đó thiết kế). Người dùng chọn dừng lại ở bước lập kế hoạch — **chưa
provision VPS, chưa viết code cho Phần B** — dự định quay lại trong thời gian tới. Ghi ở đây để phiên
sau không phải làm lại phần khảo sát.

**Quyết định đã chốt, không cần hỏi lại:**
- Hạ tầng: **Google Cloud**, dùng gói credit $300/90 ngày. Máy dev hiện chưa cài `gcloud` CLI —
  người dùng sẽ tự chạy các lệnh `gcloud`/thao tác Console, hoặc nhờ cài `gcloud` + xác thực OAuth
  khi thực sự bắt tay vào làm.
- Đa tài khoản chỉ áp dụng cho **phía Facebook đăng bài** (2-3 tài khoản). Zalo giữ nguyên 1 tài
  khoản nghe tất cả nhóm — không mở rộng.
- Cách route: mỗi tài khoản Facebook được gán **cố định** một tập khu vực/nhóm (không xoay vòng),
  xây trên `src/facebook/areaMatcher.ts` hiện có — module đó không cần sửa gì.
- Thứ tự bắt buộc: **Deploy 1-tài-khoản lên VPS trước, chạy ổn định vài ngày, rồi mới làm đa tài
  khoản.** Lý do: đa tài khoản đụng đúng chỗ rủi ro nhất (circuit breaker, browser context, job
  idempotency), và bản deploy VPS còn chưa được chứng minh — làm song song sẽ không biết lỗi mới là
  do môi trường VPS hay do refactor.
- Đăng nhập Facebook trên VPS: **đăng nhập mới từ chính IP của VPS**, không copy profile từ máy nhà
  sang (rủi ro checkpoint đã được README/RUNBOOK cảnh báo). Dùng Xvfb + VNC vì `login:facebook` bắt
  buộc `FB_HEADLESS=false`. Nghĩa là mất độ tin cậy tài khoản đã tích luỹ ở nhà, phải ramp lại từ
  `MAX_POSTS_PER_DAY` thấp.
- systemd được ưu tiên hơn pm2 cho VPS thật (không cần dependency thêm).

**Việc cụ thể còn thiếu, phát hiện lúc khảo sát (chưa fix):**
- Chưa có git repo (`git init` chưa từng chạy) dù đã có `.gitignore`.
- `.env.example` thiếu `AGENT_CONTACT_NAME`/`AGENT_CONTACT_PHONE` (có trong `.env` thật).
- `deploy/sale-room-agent.service` còn placeholder `User=deploy`/`WorkingDirectory=/opt/sale-room-agent`.
- MongoDB Atlas M0 không tự backup — chưa có cron `mongodump`.
- `backup:sessions` chỉ lưu trên chính VPS — chưa có bản sao ra ngoài.

**Thiết kế đa tài khoản (Phần B), tóm tắt — chi tiết đầy đủ cần thiết kế lại khi bắt tay code:**
Collection mới `fb_accounts` (một document/tài khoản: `browser_profile_dir`, `circuit_breaker`,
`fb_session`, `daily_counters`, `rate_limits.max_posts_per_day` riêng) thay cho phần Facebook hiện
đang dồn chung vào `app_state` singleton (`_id: "singleton"`). `groups` thêm `fb_account_id` (null =
fail-closed, không đăng). `fbBrowser.ts` từ 1 `BrowserContext` module-level thành `Map<accountId,
BrowserContext>`. `post_jobs.payload` thêm `account_id`, và **bắt buộc đưa vào `idempotency_key`**
(đúng loại lỗi từng gây collision `extract_listing`/`compose_post` khi thiếu field — xem mục
idempotency bên dưới). Scheduler chạy "tối đa 1 job/tick" **theo từng tài khoản** thay vì 1 global.
Migration: seed `fb_accounts` với 1 document `acc_default` copy nguyên trạng thái hiện tại, gán mọi
`groups` về `acc_default`, verify hành vi y hệt trước khi thêm tài khoản B/C.

Toàn văn kế hoạch chi tiết (từng bước A1-A10, B1-B10, danh sách file cần sửa) đã được duyệt trong
phiên plan-mode 2026-08-24 nhưng chỉ lưu tạm ở file plan cục bộ của Claude Code
(`C:\Users\Duong_TD\.claude\plans\`), không thuộc repo này. Khi quay lại làm, có thể yêu cầu Claude
lập lại kế hoạch chi tiết từ các quyết định đã chốt ở trên — không cần khảo sát lại kiến trúc từ đầu.

## File quan trọng nhất khi triển khai

- `src/db/collections.ts` — nền tảng schema cho toàn bộ module
- `src/jobs/jobQueue.ts` — claim job atomic, quyết định tính đúng đắn khi có nhiều worker
- `src/facebook/fbPoster.ts` + `checkpointDetector.ts` + `fbSelectors.ts` — phần rủi ro cao nhất; `fbSelectors.ts` là file phải update thường xuyên nhất khi FB đổi DOM
- `src/llm/extractor.schema.ts` + `confidenceGate.ts` — chất lượng dữ liệu đầu vào
- `src/llm/composer.prompts.ts` — template prompt quyết định chất lượng bài đăng + variation strategy
- `src/scheduler/scheduleLogic.ts` — "bộ não" điều phối rate-limit/circuit-breaker
- `src/zalo/reconnectManager.ts` — xử lý disconnect/reconnect, quyết định uptime của nguồn dữ liệu đầu vào
- `src/utils/shutdown.ts` — graceful shutdown, bảo vệ session files không bị corrupt
