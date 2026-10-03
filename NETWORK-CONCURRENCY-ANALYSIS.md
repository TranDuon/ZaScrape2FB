# Phân tích Network Programming · Concurrency · IPC — Sale room agent

## Context
Bạn cần hiểu kỹ phần kỹ thuật bên dưới codebase: agent này nói chuyện với mạng bằng giao thức gì, xử lý
đồng thời ra sao, và chịu lỗi mạng thế nào. Đây là **bản phân tích chỉ đọc code**, không sửa gì. Mục
cuối liệt kê vài rủi ro tìm thấy lúc đọc, để bạn quyết định có sửa không.

**Tóm tắt một câu:** đây là **một tiến trình Node.js duy nhất, dùng event loop, chủ yếu chủ động gọi ra
ngoài**. Nó chỉ mở đúng một cổng TCP (health, loopback). Mọi giao tiếp khác là kết nối *đi ra*:
WebSocket tới Zalo, HTTPS tới Gemini/Telegram/CDN, MongoDB wire protocol tới Atlas, và CDP qua pipe tới
Chrome. **MongoDB vừa là message broker, vừa là lock manager, vừa là kênh IPC** giữa tiến trình chính và
các script CLI.

---

## 1. Kiến trúc mạng & giao thức

### 1.1 Bản đồ giao thức

| Kết nối | Hướng | Giao thức (tầng dưới → trên) | Thư viện | Điểm vào trong code |
|---|---|---|---|---|
| Zalo realtime | ra | TCP → TLS → **WebSocket (wss)**, frame nhị phân do zca-js giải mã | `zca-js` | `src/zalo/reconnectManager.ts:73` `api.listener.start()` |
| Zalo login / group info | ra | HTTPS REST (cookie + imei + UA) | `zca-js` | `src/zalo/zaloClient.ts:69` `zalo.login()`, `reconnectManager.ts:89` `getGroupInfo` |
| Tải ảnh Zalo CDN | ra | HTTPS GET (undici `fetch`) | Node built-in | `src/zalo/mediaDownloader.ts:60` |
| Gemini | ra | HTTPS REST `models.generateContent`, body JSON | `@google/genai` | `src/llm/geminiClient.ts:199` |
| Telegram | ra | HTTPS **long polling** `getUpdates` + `sendMessage` | `node-telegram-bot-api` v2 | `src/notifier/telegramBot.ts:195`, `:102` |
| MongoDB Atlas | ra | DNS SRV → TCP → TLS → **MongoDB Wire Protocol (OP_MSG, BSON)** | `mongodb` v6 | `src/db/mongoClient.ts:13-23` |
| Facebook | ra (gián tiếp) | Node ↔ Chrome: **CDP qua pipe** (JSON-RPC); Chrome ↔ FB: HTTPS/HTTP2/QUIC | `playwright` | `src/facebook/fbBrowser.ts:26` |
| Health | **vào** | TCP listen `127.0.0.1:3100` → HTTP/1.1 | `node:http` | `src/health/healthServer.ts:96,116` |

Không có gRPC, MQTT, raw TCP/UDP socket, Redis, Kafka hay RabbitMQ.

### 1.2 Schema / contract nằm ở đâu
Không có Protobuf hay OpenAPI. Contract được khai báo bằng TypeScript + zod:
- **Response từ LLM**: định nghĩa hai lần, cố ý. `src/llm/extractor.schema.ts` có `GEMINI_RESPONSE_SCHEMA`
  (gửi lên dưới dạng `responseSchema`) và `extractionSchema` (zod, dùng để kiểm tra lại). Composer có
  `composerSchema` riêng trong `src/llm/composer.ts`.
- **Tin nhắn Zalo**: contract lấy từ type `Message` của `zca-js`, nhưng code đọc lỏng tay qua
  `AttachmentLike` (`src/zalo/messageParser.ts:23`), vì định dạng thay đổi không báo trước.
- **Env / config**: kiểm tra bằng zod trong `src/config/env.ts`.
- **Payload của job trong queue**: `src/models/job.model.ts` (`JobDoc`). Đây thực chất là
  "định dạng message" của broker.
- **Callback Telegram**: chuỗi `"action:payload"`, tách tại `telegramBot.ts:179`.
- **Response health**: `interface HealthReport`, `healthServer.ts:15`.
- **Socket event của Zalo**: `message`, `connected`, `closed(code, reason)`, `error`
  (`reconnectManager.ts:104-116`). Close code tự khai báo ở `CLOSE_REASON` (`:22`): 1000/1006 là mã
  WebSocket chuẩn, 3000/3003 là mã riêng của Zalo.

### 1.3 Serialization trên đường truyền

| Đoạn | Encode | Decode / kiểm tra | File |
|---|---|---|---|
| Zalo WS frame | nhị phân (header + payload mã hoá/nén), **nằm trong zca-js**, không có trong repo | zca-js phát ra object `Message`; `params` là **JSON lồng trong chuỗi** → `JSON.parse` | `messageParser.ts:52` |
| Gemini request | JSON; ảnh là **base64 inline** (`inlineData`) sau khi `sharp` resize → JPEG | — | `imagePreparer.ts:36,47`, `extractor.ts:198-207` |
| Gemini response | `responseMimeType: application/json` + `responseSchema` | `JSON.parse` → `zod.safeParse` → ghép theo `index` bằng `Map` | `extractor.ts:227,238,247`; `composer.ts:91,102,112` |
| Số tiền | chuỗi kiểu VN (`.` phân cách hàng nghìn) | `parseLooseNumber` | `src/llm/numberParser.ts` |
| Mongo | BSON (driver lo) | TS generic collection | `src/db/collections.ts` |
| Telegram | JSON; tin dài cắt thành đoạn ≤4096 ký tự | — | `telegramBot.ts:60` |
| Health | `JSON.stringify` | — | `healthServer.ts:107` |
| Session Zalo | JSON file, quyền 0600 | `JSON.parse` | `zaloClient.ts:30,40` |
| Log | pino NDJSON → worker thread transport | — | `src/utils/logger.ts` |

### 1.4 IPC / Message broker: MongoDB đóng cả vai broker
- **Collection `post_jobs` là message queue** (`src/jobs/jobQueue.ts`):
  - *Publisher*: `enqueueJob` (`:49`), gọi từ `messageListener.ts:206` (extract),
    `extractionWorker.ts:83` (compose), `composerWorker.ts:192` (post_to_group), và từ
    `reviewFlow`/`recompose`.
  - *Consumer*: `claimNextJob` (`:110`) bằng `findOneAndUpdate` nguyên tử. Worker extraction/compose
    gọi qua `collectJobBatch` (`batchCollector.ts:39`); posting gọi `runPostingOnce`
    (`postingWorker.ts:301`).
  - *Ack/Nack*: `completeJob` (`:158`), `failJob` (`:170`, requeue kèm `scheduled_at` backoff),
    `deferJob` (`:207`, hoàn lại `attempts`). Không có dead-letter queue riêng: `status: failed` đóng
    vai đó.
  - *Delivery semantics*: at-least-once cho extract/compose (stale → requeue). **At-most-once** cho
    post_to_group (stale → `failed`, `jobQueue.ts:268`).
  - *Dedup / exactly-once khi enqueue*: partial unique index `idempotency_active_unique`
    (`src/db/indexes.ts:36-38`).
- **Collection `app_state` là shared state / control channel**. Cờ circuit breaker, bộ đếm ngày,
  trạng thái Zalo đều nằm ở đây. Script CLI (`npm run resume`, `inject`, `reset-db`) giao tiếp với tiến
  trình chính **chỉ qua Mongo**: không có socket, không có signal.
- **`/health` qua HTTP** là IPC thứ hai: `scripts/check-stuck.ts` đọc cờ `telegram.polling`, thứ chỉ
  sống trong RAM của tiến trình chính (`telegramBot.ts:31`).
- **Chrome** là tiến trình con, nói chuyện qua CDP pipe. **pino transport** chạy trên `worker_threads`
  (thread-stream). Hai thứ này là IPC do thư viện dựng, repo không tự viết.

---

## 2. Mô hình I/O & concurrency

### 2.1 Cơ chế I/O
**Non-blocking, event loop đơn luồng (libuv)**. Mọi network I/O là `async/await`. Không có thread pool
nào do repo tự tạo. Những luồng thật sự chạy song song đều nằm ngoài code JS của bạn:
- libuv threadpool (mặc định 4 luồng): DNS `getaddrinfo` (SRV Atlas), `fs.*`, zlib, và **`sharp`** (resize
  ảnh chạy native trên threadpool).
- `worker_threads` của **pino transport** (pino-roll + pino-pretty ghi log không chặn main thread).
- **Tiến trình Chrome** riêng (Playwright).
- **Connection pool của Mongo driver** (mặc định `maxPoolSize=100`, không override,
  `mongoClient.ts:13`). Đây là pool socket, không phải thread.

### 2.2 Phân phối công việc: 4 "luồng logic" (cooperative task) chạy chung một event loop

```
                 ┌─────────── EVENT LOOP (1 thread) ───────────┐
 Zalo WS ──event──▶ MessageListener.handleMessage (fire-and-forget, không giới hạn)
                 │     └▶ MessageBatcher (Map theo thread:sender + setTimeout)
                 │          └▶ persistBatch ──insert──▶ Mongo post_jobs ◀─┐
                 │                                                        │ poll 5s
 Task A ─────────▶ extraction loop: while(!stop){ collectJobBatch → Gemini }│
 Task B ─────────▶ composer loop:   while(!stop){ collectJobBatch → Gemini }│
 Task C ─────────▶ node-cron tick (noOverlap) → runCycle → 1 job → Chrome ─┘
 Task D ─────────▶ maintenance crons (5 lịch, độc lập)
 Task E ─────────▶ Telegram long-poll loop (bên trong thư viện)
 Task F ─────────▶ http.Server :3100
                 └──────────────────────────────────────────────┘
```

| Dispatcher | Nơi khởi tạo | Kiểu | Pacing |
|---|---|---|---|
| Zalo `message` event | `messageListener.ts:29-35` | push, `void this.handleMessage()` → không có hàng đợi, không giới hạn concurrency | theo lưu lượng Zalo |
| Extraction worker | `extractionWorker.ts:233`, bật tại `index.ts:64` | pull-loop + batch window | ngủ `WORKER_POLL_INTERVAL_MS` (5s) khi rỗng |
| Composer worker | `composerWorker.ts:415`, `index.ts:67` | pull-loop, `newest_first`, có ngân sách ngày | như trên |
| Posting | `cronRunner.ts:35`, `index.ts:72` | cron tick, **≤1 job/tick** | `SCHEDULER_TICK_CRON` + jitter 5 phút |
| Maintenance | `maintenance/cronJobs.ts:107` | cron | 10 phút / 1 giờ / hằng ngày / hằng tuần |
| Telegram updates | `telegramBot.ts:195` | long-poll, handler chạy nối tiếp theo từng update | server giữ kết nối |
| Health | `healthServer.ts:96` | request/response, mỗi request 7 query Mongo chạy song song (`Promise.all`) | theo request |

`startPostingWorker` (`postingWorker.ts:321`) **có code nhưng không được gắn vào `index.ts`**, cố ý.

### 2.3 Đồng bộ hoá: lock nằm ở đâu
Trong một event loop không có data race kiểu đa luồng. **Race vẫn xảy ra ở mỗi điểm `await`**, và giữa
nhiều tiến trình (script CLI, instance thứ hai). Các primitive đang dùng:

| Primitive | Tương đương | Vị trí | Bảo vệ cái gì |
|---|---|---|---|
| `findOneAndUpdate({status:"pending"})` → `processing` | **CAS / atomic claim** (optimistic lock phân tán) | `jobQueue.ts:113` | một job chỉ về tay một worker, kể cả khi nhiều tiến trình |
| Lặp claim từng job thay vì đọc rồi ghi cả loạt | tránh TOCTOU | `jobQueue.ts:146` | như trên, áp cho lô |
| Partial unique index trên `idempotency_key` | **mutex idempotency** (chỉ giữ khi job còn active) | `indexes.ts:36-38`, key ở `jobQueue.ts:33` | không enqueue trùng |
| Unique index `source.message_ids` | dedup | `indexes.ts:21-23`, bắt lỗi 11000 ở `messageListener.ts:196` | không lưu lại tin Zalo khi replay |
| `$inc` (daily_metrics, counters, `attempts`) | **atomic counter** | `indexes.ts:96`, `rateLimiter.ts:158,163`, `jobQueue.ts:123,221` | bộ đếm không mất cập nhật |
| `noOverlap: true` của node-cron | **mutex không vào lại** cho tick | `cronRunner.ts:61`, `cronJobs.ts:117,123` | không mở 2 lần Chrome cùng lúc |
| cờ `reconnecting` (boolean) | **mutex cooperative** | `reconnectManager.ts:176` | chỉ có một vòng reconnect |
| `batches.delete(key)` **trước** `await onFlush` | tách ownership trước điểm yield | `messageBatcher.ts:224` | tin đến giữa lúc flush mở batch mới, không bị gộp nhầm vào batch đang đóng |
| singleton `context` / `client` / `db` | lazy-init | `fbBrowser.ts:22`, `geminiClient.ts:102`, `mongoClient.ts:11` | ⚠ **không có** promise-guard: 2 lần gọi đồng thời lúc đầu có thể init 2 lần. Hiện an toàn chỉ vì posting chạy nối tiếp |
| `exhaustedUntil` Map cấp module | shared cache | `geminiClient.ts:35` | model hết quota. Chỉ đúng trong một tiến trình |
| `isShuttingDown()` | cancellation token | `shutdown.ts:15`, truyền vào worker và `batchCollector.ts:49` | dừng vòng lặp êm |

---

## 3. Vòng đời kết nối & packet trace

### 3.1 Vòng đời từng kết nối

**(a) Cổng duy nhất mở ra ngoài: Health HTTP**
`listen` `healthServer.ts:116` (bind `127.0.0.1`, cổng mặc định 3100) → accept/parse do `node:http` lo
→ handler `:96` (lọc path `/health`) → `buildReport` → `writeHead(200|503)` + JSON → keep-alive theo mặc
định Node → đóng: `stopHealthServer` `:128` (`server.close` ngừng nhận kết nối mới, chờ kết nối đang mở).

**(b) Zalo WebSocket: kết nối sống lâu, trọng tâm của hệ thống**
1. *Handshake phiên*: `loginWithSavedSession` (`zaloClient.ts:55`) đọc cookie/imei/UA → HTTPS login.
2. *Bind handler*: `listener.attach(api)` (`reconnectManager.ts:67`) + `bindLifecycle` (`:68`).
3. *Mở WS*: `api.listener.start({ retryOnClose: false })` (`:73`). Tắt retry của thư viện để app tự
   phân loại lỗi.
4. *Connected*: `handleConnected` (`:118`) đặt `attempts=0`, xoá cờ breaker, cảnh báo nếu im lặng >5 phút.
5. *Read*: event `message` → `messageListener.ts:30`.
6. *Heartbeat*: ping/keep-alive **nằm trong zca-js**. Ở tầng app, "heartbeat" là
   `zalo_session.last_message_at` (`messageListener.ts:104`), dùng để phát hiện khoảng trống.
7. *Disconnect*: `closed(code)` → `handleClosed` (`:158`). Nếu code 3000/3003 → `trip` (`:216`, dừng hẳn).
   Code khác → `scheduleReconnect` (`:175`, exponential backoff + jitter, tối đa
   `ZALO_RECONNECT_MAX_ATTEMPTS`) → hết lượt thì `trip`.
8. *Graceful*: `reconnect.stop()` (`:57`) → `listener.stop()` → `listener.flushPending()` chốt batch
   đang mở (`index.ts:58-62`).

**(c) MongoDB**: `connectMongo` (`mongoClient.ts:10`) = SRV lookup + TLS + handshake (`hello`) + `ping`.
Pool tự quản lý, tự heartbeat (SDAM monitor khoảng 10s). `retryWrites/retryReads` thử lại 1 lần khi gặp
lỗi mạng hoặc failover. Đóng: `closeMongo` là task shutdown **cuối cùng** (đăng ký đầu tiên, `index.ts:41`).

**(d) Telegram long polling**: `startPolling` (`telegramBot.ts:195`) giữ HTTP request `getUpdates` treo
tới khi có update. Lỗi tạm thời → thư viện thử lại vô hạn, **không advance offset** (không mất lệnh).
Lỗi fatal → promise reject → `pollingAlive=false` (`:199-209`). Dừng: `bot.stop()` + `await polling`
(`:214`).

**(e) Chrome / CDP**: `launchPersistentContext` (`fbBrowser.ts:26`) spawn Chrome và nối pipe, lazy-init
ở lần đăng đầu tiên. Tab được tái dùng (`newPage` `:73`). Timeout mặc định mỗi action là
`FB_ACTION_TIMEOUT_MS` (`:48`). Đóng: `closeBrowser` (`:60`).

**(f) Gemini / CDN / Telegram send**: HTTP ngắn hạn qua global agent của undici (keep-alive pool mặc
định). Không có kết nối nào được giữ theo kiểu tường minh.

**Graceful shutdown tổng**: SIGINT/SIGTERM → `shutdown.ts:31`. Đặt `shuttingDown=true`, hẹn giờ thoát
cứng 30s (`:39`), rồi chạy task **theo thứ tự ngược lúc đăng ký** (`:45`): maintenance → health →
**fb-browser → scheduler** → composer → extraction → zalo-listener → telegram → mongodb. (Xem rủi ro R1.)

### 3.2 Tracer mẫu: một tin Zalo đi thành bài Facebook
Đây là luồng tiêu biểu nhất vì nó đi qua **mọi** giao thức và mọi primitive đồng bộ.

```
[1] Endpoint (outbound WSS tới Zalo)
    src/zalo/reconnectManager.ts:73      api.listener.start({retryOnClose:false})
[2] Network transport / handler
    src/zalo/messageListener.ts:30       listener.on("message") → void handleMessage()
    src/zalo/messageListener.ts:47,52    lọc isSelf, allowlist thread/sender
[3] Framing / parsing
    src/zalo/messageParser.ts:100        classify text | image | other (JSON.parse params :52)
    src/zalo/messageBatcher.ts:102,157   framing ở tầng ứng dụng: TIN CHỮ = delimiter giữa các "gói",
                                         idle timer 45s / hard cap 300s (:197,:200) = timeout của frame
    src/zalo/messageBatcher.ts:218       flush (delete-before-await)
[4a] Persist + fan-in vào broker
    src/zalo/messageListener.ts:150      intake cap (countDocuments)
    src/zalo/mediaDownloader.ts:60       HTTPS GET ảnh, AbortSignal.timeout 30s
    src/zalo/messageListener.ts:193      insertOne listings (unique message_ids)
    src/jobs/jobQueue.ts:49,77           enqueueJob extract_listing (idempotency index)
[4b] Worker: extraction (Gemini HTTPS)
    src/jobs/extractionWorker.ts:253     vòng lặp → runExtractionBatch
    src/jobs/batchCollector.ts:40        claimNextJobs (atomic) + gom thêm trong 5 phút
    src/llm/imagePreparer.ts:36,47       sharp → base64 (mặc định MAX_IMAGES_PER_EXTRACTION=0)
    src/llm/extractor.ts:198             ghép parts xen kẽ chữ/ảnh
    src/llm/geminiClient.ts:199          generateContent (retry / fallback / phân loại 429)
    src/llm/extractor.ts:227,238,247     JSON.parse → zod → Map theo index
    src/jobs/extractionWorker.ts:40      applyOutcome → confidenceGate → enqueue compose_post (:83)
                                         → Telegram notify → completeJob (:115)  ← ACK
[4c] Worker: composer
    src/jobs/composerWorker.ts:260       collectJobBatch newest_first
    src/jobs/composerWorker.ts:311,329   deferJob khi hết ngân sách ngày (backpressure)
    src/jobs/composerWorker.ts:370       composePosts (Gemini)
    src/jobs/composerWorker.ts:129,192   staggeredSchedule → enqueue N job post_to_group có scheduled_at
[4d] Worker: posting (CDP → Facebook)
    src/scheduler/cronRunner.ts:35       tick noOverlap + maxRandomDelay
    src/scheduler/scheduleLogic.ts:27    breaker → giờ hoạt động → postsTodayCount → requeueStale
    src/jobs/postingWorker.ts:301        claimNextJob("post_to_group")
    src/jobs/postingWorker.ts:150        checkPostingAllowed (rate limiter)
    src/jobs/postingWorker.ts:187-188    newPage + checkSession (goto facebook.com)
    src/jobs/postingWorker.ts:201        post_history "attempting" (write-ahead log!)
    src/facebook/fbPoster.ts:305         goto group URL
    src/facebook/fbPoster.ts:327,335     typeLikeHuman / attachImages (filechooser :257)
    src/facebook/fbPoster.ts:351,361     verifyComposedText → submit.click  ← điểm không quay lại được
[5] Response / Ack
    src/jobs/postingWorker.ts:212        post_history success | pending_approval
    src/facebook/rateLimiter.ts:153      recordSuccessfulPost ($inc)
    src/jobs/postingWorker.ts:231        completeJob  ← ACK cuối
    src/jobs/postingWorker.ts:250        sendNotification → Telegram HTTPS (retry 4 lần)
```
Chú ý mẫu **write-ahead** ở bước 4d: ghi `attempting` trước khi có side effect bên ngoài. Đây chính là
kỹ thuật dùng cho bài toán "two generals" giữa DB và Facebook. `stalePostReaper` là bước recovery đọc lại
cái log đó.

---

## 4. Chịu lỗi mạng & tinh chỉnh

### 4.1 Backpressure
Không có hàng đợi bị giới hạn trong RAM. **Áp lực được chặn ở từng tầng bằng hạn mức và nhịp**, còn
Mongo đóng vai buffer bền:
1. **Intake cap theo thread/ngày**: `messageListener.ts:150-159`. Cắt ở cửa trước khi tốn I/O.
2. **Allowlist**: `messageListener.ts:94`. Drop trước khi parse.
3. **Batch size + window**: `batchCollector.ts` (`EXTRACTION_BATCH_SIZE=5`, `COMPOSE_BATCH_SIZE=3`,
   `LLM_BATCH_WINDOW_MS`). Giới hạn kích thước request (chống output bị cắt cụt).
4. **`EXTRACTION_BATCH_MAX_IMAGES`**: giới hạn payload base64 của mỗi request.
5. **Ngân sách soạn bài ngày + `deferJob`**: `composerWorker.ts:311`. Chặn fan-out.
6. **Posting ≤1 job/tick + `noOverlap`**: đây là token bucket 1 token/tick.
7. **Rate limiter** (`rateLimiter.ts:108`): giới hạn ngày, giới hạn theo group, `min_interval_minutes`.
   Kết quả là *hoãn* (`retryAt`) chứ không phải *lỗi*.
8. **Listing expiry** + TTL index: giới hạn độ lớn của broker.
9. **Telegram**: `splitLongMessage` (giới hạn 4096 ký tự).

⚠ Khoảng hở: đường event Zalo → `handleMessage` **không có giới hạn concurrency**. Khi Zalo replay lịch
sử theo đợt, mỗi tin sinh một `updateOne` (`markMessageSeen`) chạy song song. Hiện Mongo pool 100 hấp
thụ được.

### 4.2 Timeout · Retry · Circuit breaker · Reconnect

| Đối tượng | Timeout | Retry | Breaker / fail-fast |
|---|---|---|---|
| Zalo WS | trong zca-js | backoff mũ + jitter, `ZALO_RECONNECT_MAX_ATTEMPTS`, trần `ZALO_RECONNECT_MAX_BACKOFF_MS` (`reconnectManager.ts:180`) | 3000/3003 hoặc hết lượt → `zalo_circuit_breaker`, **không tự mở lại** |
| Tải ảnh | `AbortSignal.timeout(30s)` (`mediaDownloader.ts:60`) | không retry; lỗi ghi `download_error`, không throw | — |
| Gemini | ⚠ **không đặt timeout HTTP** | 5 lần, 2s→60s + jitter, chỉ với 429/5xx/null (`geminiClient.ts:258-273`) | 2 lần 503 → fallback model; 429 PerDay → đánh dấu hết quota tới nửa đêm Pacific (breaker theo model); 429 hết credits → dừng ngay |
| Job extract/compose | stale 15 phút | `failJob` backoff 30s→10 phút, `max_attempts=3` | `failed` |
| Job post | stale 15 phút | backoff 5 phút→1 giờ | Checkpoint → **không retry** + `circuit_breaker` Facebook (`postingWorker.ts:32`) |
| Playwright | `FB_ACTION_TIMEOUT_MS` 30s mỗi action; filechooser 15s; preview 20s | qua job queue | checkpoint detector sau mỗi bước |
| Telegram send | thư viện lo | 4 lần [1s,3s,8s], chỉ `isTransientError` (`telegramBot.ts:99`) | không bao giờ throw ra ngoài |
| Telegram poll | server giữ | vô hạn khi lỗi tạm thời | lỗi fatal → `pollingAlive=false` → `/health` |
| Mongo | `serverSelectionTimeoutMS=10s` | driver retry 1 lần | — |
| Shutdown | cứng 30s (`shutdown.ts:19`) | — | `process.exit(1)` |

Jitter nằm ở `utils/delay.ts:15`, cron `maxRandomDelay`, `humanPause`. Ở đây jitter phục vụ **hai mục
đích**: tránh thundering herd *và* chống bị nhận diện là bot.

### 4.3 Connection pooling / tái sử dụng
- **Mongo**: một `MongoClient` singleton (`mongoClient.ts:7`) cho cả tiến trình, pool mặc định.
- **Gemini**: một `GoogleGenAI` singleton (`geminiClient.ts:96`), bên dưới dùng keep-alive pool của undici.
- **Chrome**: một `BrowserContext` persistent singleton, tái dùng tab đầu tiên. Không mở mới mỗi bài.
- **Telegram**: một `Bot` singleton.
- **Zalo**: đúng một WS (bắt buộc, zca-js chỉ cho một web session). Reconnect tạo `API` mới.

---

## 5. Reading checklist

| Ưu tiên | File / thư mục | Thành phần mạng/luồng cần mổ xẻ |
|---|---|---|
| **P0** | `src/jobs/jobQueue.ts` | atomic claim (CAS), idempotency, at-least vs at-most-once, stale sweep |
| **P0** | `src/index.ts` + `src/utils/shutdown.ts` | thứ tự khởi động, dispatcher, graceful shutdown LIFO |
| **P0** | `src/zalo/reconnectManager.ts` | vòng đời WS, phân loại close code, backoff, breaker |
| **P0** | `src/zalo/messageBatcher.ts` | framing ở tầng app, timer, ownership trước `await` |
| **P0** | `src/jobs/postingWorker.ts` | write-ahead `attempting`, ack/nack, breaker Facebook |
| P1 | `src/jobs/batchCollector.ts` | batching window, cancellation |
| P1 | `src/llm/geminiClient.ts` | phân loại lỗi HTTP, fallback, quota breaker trong RAM |
| P1 | `src/scheduler/cronRunner.ts` + `scheduleLogic.ts` | tick mutex (`noOverlap`), jitter, gate order |
| P1 | `src/zalo/messageListener.ts` | fire-and-forget dispatch, intake cap, dedup key |
| P1 | `src/db/indexes.ts` + `mongoClient.ts` | partial unique / TTL index, cấu hình driver |
| P1 | `src/notifier/telegramBot.ts` | long polling, retry gửi, liveness flag, authz |
| P1 | `src/facebook/fbBrowser.ts` + `fbPoster.ts` | CDP lifecycle, timeout mỗi action, filechooser race |
| P2 | `src/facebook/rateLimiter.ts` | token/interval gate, counter rollover |
| P2 | `src/health/healthServer.ts` | server duy nhất, bind loopback |
| P2 | `src/zalo/messageParser.ts`, `mediaDownloader.ts` | decode payload, HTTP download |
| P2 | `src/llm/extractor.ts`, `composer.ts`, `imagePreparer.ts` | serialization request/response |
| P2 | `src/maintenance/cronJobs.ts`, `stalePostReaper.ts` | recovery của write-ahead log |

### Bài test / breakpoint để quan sát trực tiếp

**T1: Race trên atomic claim (không cần Gemini)**
```
npm run test:jobqueue
```
Đặt breakpoint tại `src/jobs/jobQueue.ts:113` (findOneAndUpdate) và `:132`. Bạn sẽ thấy 10 promise
claim cùng lúc nhưng đúng 1 lần trả về document khác null. Bổ sung (sửa tạm tại chỗ, không commit): thêm
`monitorCommands: true` vào options ở `mongoClient.ts:13` và
`client.on("commandStarted", e => console.log(e.commandName, e.command))`. Log sẽ in từng lệnh
`findAndModify` bay qua wire.

**T2: Trace trọn một "gói" từ broker → Gemini → ack**
```
# PowerShell
$env:LOG_LEVEL="debug"; $env:LLM_BATCH_WINDOW_MS="0"; $env:NODE_DEBUG="http,tls"
npm run dev            # terminal 1
npm run inject -- 0    # terminal 2
```
Breakpoint: `batchCollector.ts:40` → `geminiClient.ts:199` → `extractor.ts:238` →
`extractionWorker.ts:83` (enqueue compose) → `:115` (ack). `NODE_DEBUG=http,tls` in ra lúc mở và tái
dùng socket keep-alive tới Google/Telegram. Để xem CDP khi posting chạy: `$env:DEBUG="pw:protocol"`
(rất nhiều log, chỉ bật khi chạy `npm run test:fbpost -- <groupId> --dry-run`).

**T3: Framing + reconnect + health**
- `npx vitest run test/unit/messageBatcher.test.ts`: replay 149 tin thật, quan sát 20 frame.
  Breakpoint tại `messageBatcher.ts:114` và `:224`.
- Khi `npm run dev` đang chạy: ngắt Wi-Fi 30s rồi bật lại. Theo dõi log `zalo:reconnect`
  ("Mất kết nối Zalo, sẽ thử lại" với `delay_ms` tăng dần), và gọi
  `curl http://127.0.0.1:3100/health` trước/trong/sau để thấy `zalo.connected` và `status` đổi
  `ok → degraded → ok`. Breakpoint tại `reconnectManager.ts:158` và `:197`.

---

## Phụ lục: rủi ro phát hiện khi đọc (chưa sửa, cần bạn quyết)

- **R1. Thứ tự shutdown ngược với ý định.** `index.ts:73-76` đăng ký `scheduler` rồi mới đến
  `fb-browser`, còn `shutdown.ts:45` chạy theo LIFO. Vì vậy **Chrome bị đóng TRƯỚC khi scheduler dừng**,
  ngược hẳn với comment "đóng trình duyệt SAU khi bộ điều phối dừng hẳn". Nếu SIGTERM đến giữa lúc đang
  đăng, profile có thể hỏng và bài có thể lên dở. Cách sửa: đăng ký `fb-browser` *trước* `scheduler`.
  Nên kiểm tra thêm `task.stop()` của node-cron v4 có chờ lần chạy đang dở hay không.
- **R2. Gemini không có HTTP timeout** (`geminiClient.ts:199`). Một socket treo sẽ chặn cả worker loop.
  Trong lúc đó `runCycle` gọi `requeueStaleJobs` mỗi tick (`scheduleLogic.ts:50`), nên sau 15 phút job
  extract/compose **đang chạy thật** sẽ bị trả về `pending` và xử lý hai lần. Nên đặt timeout request
  cho SDK, và giữ timeout đó nhỏ hơn nhiều so với `STALE_JOB_MS`.
- **R3. TOCTOU ở intake cap.** `addText` gọi `void this.flush()` (`messageBatcher.ts:114`), nên nhiều
  `persistBatch` có thể chạy chồng nhau. Mỗi cái `countDocuments` (`messageListener.ts:150`), rồi tải ảnh
  mất vài giây, rồi mới `insertOne`. Khi có bulk dump, cap có thể bị vượt vài tin.
- **R4. Tải ảnh buffer toàn bộ rồi mới kiểm tra kích thước** (`mediaDownloader.ts:63-65`). Không xét
  `content-length` trước và không cắt stream.
- **R5. Default `SCHEDULER_TICK_CRON` trong `env.ts:148` là `*/2`**, trong khi tài liệu nói đang chạy
  `*/20`. Giá trị an toàn phụ thuộc hoàn toàn vào `.env`. Nếu mất dòng đó sẽ quay lại burst gây ra sự cố
  2026-08-25.
- **R6. Singleton lazy-init không có promise guard** (`fbBrowser.ts:21`). Hiện vô hại vì posting chạy
  nối tiếp, nhưng sẽ vỡ nếu sau này chạy song song (ví dụ Phase 10 đa tài khoản).
