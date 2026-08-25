# Phân tích Lập trình Mạng — Dự án Agent tự động Zalo → MongoDB → Facebook

> **Mục đích tài liệu**: Phân tích chuyên sâu các khía cạnh lập trình mạng được áp dụng trong dự án, phục vụ đánh giá môn học Lập trình Mạng. Tài liệu này là bản song song với `plan.md` — mọi tính năng kỹ thuật đều đã được hiện thực hóa trong bản kế hoạch gốc, tài liệu này tập trung phân tích lý thuyết và động cơ đằng sau các quyết định mạng đó.

---

## Tổng quan hệ thống từ góc độ mạng

Dự án này là một **distributed agent** không phải theo nghĩa multi-node, mà theo nghĩa **một tiến trình duy nhất đóng vai trò client cho nhiều giao thức và dịch vụ mạng khác nhau đồng thời**:

```
┌──────────────────────────────────────────────────────────────────┐
│                  sale-room-agent (Node.js process)               │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ Zalo Client │  │ MongoDB      │  │ HTTP Health Server   │   │
│  │ (WebSocket/ │  │ Client       │  │ (TCP server, 3100)   │   │
│  │  long-poll) │  │ (TCP+TLS)    │  └──────────────────────┘   │
│  └──────┬──────┘  └──────┬───────┘                              │
│         │                │          ┌──────────────────────┐   │
│  ┌──────▼──────┐  ┌──────▼───────┐  │ Playwright (Chrome)  │   │
│  │ Telegram    │  │ Claude API   │  │ (TCP+TLS → Facebook) │   │
│  │ Bot Client  │  │ (HTTPS REST) │  └──────────────────────┘   │
│  │ (HTTPS REST)│  └──────────────┘                              │
│  └─────────────┘                                                 │
└──────────────────────────────────────────────────────────────────┘
```

**5 kết nối mạng hoạt động song song**:

| Kết nối | Giao thức | Hướng | Mục đích |
|---|---|---|---|
| Zalo ↔ App | WebSocket / Long-poll (HTTPS) | Inbound (nhận) | Nhận tin nhắn thời gian thực |
| App → MongoDB Atlas | TCP + TLS 1.3 | Outbound | Lưu trữ & truy vấn dữ liệu |
| App → Claude API | HTTPS (REST) | Outbound | LLM inference |
| App → Telegram API | HTTPS (REST) | Outbound (polling) | Điều khiển & thông báo |
| Playwright → Facebook | HTTPS (browser) | Outbound | Đăng bài tự động |

---

## 1. Mô hình TCP/IP và vị trí của từng module

### 1.1 Ánh xạ vào mô hình TCP/IP

```
┌────────────────┬───────────────────────────────────────────────────────────┐
│   Tầng         │  Thành phần trong dự án                                   │
├────────────────┼───────────────────────────────────────────────────────────┤
│ Application    │  zca-js (Zalo protocol), MongoDB Wire Protocol,           │
│                │  HTTP/1.1 + HTTP/2 (Claude API, Telegram API),            │
│                │  WebSocket, Playwright CDP (Chrome DevTools Protocol)     │
├────────────────┼───────────────────────────────────────────────────────────┤
│ Transport      │  TCP (tất cả kết nối), TLS 1.2/1.3 bọc ngoài TCP        │
│                │  → TCP đảm bảo: ordering, reliable delivery, flow control │
├────────────────┼───────────────────────────────────────────────────────────┤
│ Network        │  IPv4/IPv6 (tùy ISP/VPS provider)                        │
│                │  DNS resolution: SRV records cho MongoDB Atlas            │
├────────────────┼───────────────────────────────────────────────────────────┤
│ Link/Physical  │  Ethernet (VPS datacenter) — không tương tác trực tiếp   │
└────────────────┴───────────────────────────────────────────────────────────┘
```

### 1.2 Tại sao toàn bộ dùng TCP, không phải UDP?

**Lý do**: Tất cả dữ liệu trong hệ thống đều là **critical data** — tin nhắn Zalo không thể mất (bỏ sót phòng trọ), lệnh MongoDB không thể đến lộn thứ tự (integrity), bài đăng Facebook không thể gửi thiếu. UDP phù hợp khi chấp nhận mất gói (streaming video, game real-time) — không phù hợp use case này.

**TLS trên TCP**: Mọi kết nối đều dùng TLS (HTTPS = HTTP + TLS, `mongodb+srv` mặc định bật TLS). Điều này đảm bảo:
- **Confidentiality**: Credentials Zalo/Facebook không bị sniff trên đường truyền.
- **Integrity**: Message authentication code (MAC) trong TLS record layer phát hiện dữ liệu bị sửa đổi.
- **Authentication**: Certificate của server được verify — tránh MITM attack.

---

## 2. Kết nối Zalo — WebSocket và Reverse-Engineered Protocol

### 2.1 Thách thức cốt lõi: Không có API chính thức

Zalo không cung cấp API cho tài khoản cá nhân. Thư viện `zca-js` hoạt động bằng cách **reverse-engineer** giao thức mạng của ứng dụng Zalo Web, tái hiện chính xác các HTTP request/WebSocket frame mà trình duyệt gửi.

### 2.2 Cơ chế giao tiếp: Long-Polling vs WebSocket

Zalo Web dùng **kết hợp hai cơ chế**:

**Long-Polling (HTTP/1.1)** — cho các API request thông thường:
```
Client                              Zalo Server
  │──── HTTP POST /api/login ────────────────→│
  │←─── HTTP 200 { token, session } ──────────│
  │                                            │
  │──── HTTP GET /api/listen (giữ kết nối) ──→│
  │     [server giữ request này mở]            │
  │     [khi có tin nhắn mới...]               │
  │←─── HTTP 200 { messages: [...] } ─────────│ (response sau vài giây/phút)
  │──── HTTP GET /api/listen (request mới) ──→│ (lập tức reconnect)
```

**WebSocket** — cho push notification thời gian thực:
```
Client                              Zalo Server
  │──── HTTP GET /ws (Upgrade: websocket) ───→│
  │←─── HTTP 101 Switching Protocols ─────────│
  │──────── [WebSocket Handshake] ────────────│
  │←─── WS Frame: { type: "new_message" } ───│ (server push, không cần poll)
  │←─── WS Frame: { type: "typing" } ────────│
  │←─── WS Frame: { type: "seen" } ──────────│
```

**Tại sao WebSocket tốt hơn HTTP polling thuần túy?**

| Tiêu chí | HTTP Short Polling | HTTP Long Polling | WebSocket |
|---|---|---|---|
| Overhead mỗi message | Header đầy đủ (~200-800 bytes) | Header đầy đủ | Frame header 2-10 bytes |
| Độ trễ nhận tin | = polling interval | ~RTT | ~RTT |
| Hướng giao tiếp | Half-duplex | Half-duplex | Full-duplex |
| Số TCP connections | Nhiều | Ít hơn | 1 persistent |
| Tải server | Cao (N requests/giây) | Trung bình | Thấp |

### 2.3 Session Management và Cookie

`zca-js` quản lý session tương đương như trình duyệt:

```
HTTP Cookie-Based Session (RFC 6265):

1. Login:  POST /login → Set-Cookie: zsid=<token>; HttpOnly; Secure; ...
2. Mọi request tiếp theo: Cookie: zsid=<token>
3. Refresh: khi token sắp hết hạn → gọi /refresh_token
4. Persist: zca-js serializes cookies → data/zalo-session/
            → load lại khi app restart
```

**Rủi ro mạng**: Server có thể invalidate session bất kỳ lúc nào (logout từ thiết bị khác, phát hiện bất thường). Đây là lý do cần `reconnectManager.ts`.

### 2.4 Reconnect với Exponential Backoff — Phân tích kỹ thuật

Khi kết nối WebSocket/HTTP mất, không được retry ngay lập tức (gây DDoS chính mình):

```
Lần 1: chờ 1s   → retry
Lần 2: chờ 2s   → retry
Lần 3: chờ 4s   → retry
Lần 4: chờ 8s   → retry
Lần 5: chờ 16s  → retry (nếu vẫn fail → trip zalo_circuit_breaker)
...
Lần N: chờ min(2^N * BASE, MAX_BACKOFF) + random_jitter
```

**Jitter (ngẫu nhiên hóa)**: Không có jitter → nhiều client cùng disconnect sẽ cùng retry đúng thời điểm → gây **thundering herd** (bão kết nối). Thêm jitter phân phối đều các retry:

```typescript
const delay = Math.min(
  BASE_DELAY_MS * Math.pow(2, attemptNumber),
  ZALO_RECONNECT_MAX_BACKOFF_MS   // 300_000 ms = 5 phút
) + Math.random() * JITTER_MS;
```

**Ngưỡng dừng (Circuit Breaker)**: Sau `ZALO_RECONNECT_MAX_ATTEMPTS = 5` lần liên tiếp thất bại → không retry vô hạn, trip circuit breaker và notify người dùng. Điều này quan trọng vì: nếu session đã bị revoke phía server, retry mãi cũng vô ích và còn có thể trigger rate limit / IP ban.

### 2.5 Message Gap Detection — Vấn đề với kết nối không tin cậy

```
Timeline:
──────────────────────────────────────────────────────────→ thời gian
    [connected]   [DISCONNECT]   [reconnect]
         │              │              │
    last_msg_at       gap           now
         └──────────────┼──────────────┘
                   Δt = now - last_msg_at
                   nếu Δt > 5 phút → có thể miss tin nhắn
```

**Vấn đề**: Zalo không có API "fetch messages while I was offline" cho client không chính thức. Khi reconnect, `zca-js` chỉ nhận tin nhắn mới từ thời điểm đó. Các tin trong khoảng `gap` có thể bị mất.

**Giải pháp**: Phát hiện gap và cảnh báo người dùng can thiệp thủ công — đây là giới hạn kỹ thuật không thể vượt qua được với giao thức reverse-engineered.

---

## 3. Kết nối MongoDB Atlas — TCP, TLS và DNS SRV

### 3.1 Connection String và DNS SRV Records

```
mongodb+srv://username:password@cluster.mongodb.net/sale_room_agent
              └───────────────────────────────────┘
                    hostname dùng DNS SRV lookup
```

Khi app khởi động, MongoDB driver thực hiện chuỗi DNS lookup:

```
Bước 1: DNS SRV lookup
  _mongodb._tcp.cluster.mongodb.net → [
    SRV: shard1-primary.cluster.mongodb.net:27017   (priority=100),
    SRV: shard1-secondary1.cluster.mongodb.net:27017 (priority=50),
    SRV: shard1-secondary2.cluster.mongodb.net:27017 (priority=50)
  ]

Bước 2: DNS TXT lookup (replica set config)
  cluster.mongodb.net → "replicaSet=atlas-xxx&authSource=admin&ssl=true"

Bước 3: TCP connect + TLS handshake đến primary
  → TLS 1.3 Certificate Verification (Atlas CA)
  → SCRAM-SHA-256 Authentication

Bước 4: MongoDB Wire Protocol over TCP
  → Heartbeat ping mỗi 10s để detect server failure
```

**Lợi ích của SRV so với hardcoded IP**: Nếu Atlas migration cluster sang IP mới, chỉ DNS record thay đổi — app không cần reconfigure. Với hardcoded IP: app bị down ngay khi Atlas rotate IP.

### 3.2 Connection Pooling — Tái sử dụng TCP Connection

Mở/đóng TCP connection cho mỗi query là cực kỳ tốn kém:
- **TCP 3-way handshake**: 1 RTT
- **TLS 1.3 handshake**: 1 RTT (full handshake) hoặc 0-RTT (session resumption)
- **Tổng**: ~2 RTT = **40-100ms** với VPS trong nước/khu vực

**Connection Pool** (MongoDB driver mặc định):

```
┌─────────────────────────────────────────────────────────────────┐
│                    Connection Pool (maxPoolSize=10)             │
│                                                                 │
│  Conn1 [IDLE]  Conn2 [ACTIVE-query]  Conn3 [IDLE]  ...        │
│                                                                 │
│  Khi có query → lấy connection IDLE từ pool (0ms wait)         │
│  Khi xong query → trả connection về pool (không đóng TCP)      │
│  Khi pool cạn → queue request, chờ connection được trả về      │
│  Khi connection lỗi → pool tự tạo connection mới               │
└─────────────────────────────────────────────────────────────────┘
```

**Cấu hình phù hợp** với dự án single-process này:
```typescript
const client = new MongoClient(uri, {
  maxPoolSize: 10,              // tối đa 10 TCP connections đồng thời
  minPoolSize: 2,               // luôn giữ 2 warm connections
  serverSelectionTimeoutMS: 5000,   // timeout khi không tìm được server
  socketTimeoutMS: 30000,           // timeout từng operation
  heartbeatFrequencyMS: 10000,      // ping server mỗi 10s
});
```

### 3.3 Atomic Operations — Giải quyết Race Condition qua Mạng

**Vấn đề**: Extraction worker và posting worker cùng poll `post_jobs`. Nếu cả hai cùng thấy 1 job `pending` và cùng claim → **race condition** → job bị xử lý 2 lần.

**Giải pháp**: Lệnh `findOneAndUpdate` là **atomic tại server MongoDB** — dù 2 request gửi đồng thời qua mạng, server xử lý tuần tự nhờ locking:

```typescript
const claimed = await db.collection('post_jobs').findOneAndUpdate(
  { status: 'pending', scheduled_at: { $lte: new Date() } },
  { $set: { status: 'claimed', claimed_at: new Date(), claimed_by: process.pid } },
  { sort: { scheduled_at: 1 }, returnDocument: 'after' }
);
// null → không có job
// object → job này thuộc về worker hiện tại (guaranteed)
```

**Tại sao atomic quan trọng trong mạng**: Giữa "đọc job" và "cập nhật status" có network round-trip. Nếu dùng 2 lệnh riêng (find → update), worker khác có thể claim job đó trong khoảng trống. `findOneAndUpdate` loại bỏ khoảng trống bằng cách gộp thành 1 atomic operation phía server.

### 3.4 Partial Unique Index — Giải quyết Network Retry Idempotency

```javascript
// Index chống duplicate job — partial để cho phép retry
db.post_jobs.createIndex(
  { idempotency_key: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["pending", "claimed", "processing"] }
    }
  }
)
```

**Phân tích**: Khi composer worker gửi request tạo job qua mạng rồi bị timeout (network hiccup), worker có thể retry — nhưng server đã nhận và tạo job thành công lần đầu. Nếu dùng unique index thông thường → retry bị chặn với lỗi duplicate key → job không được tạo → tin nhắn không được đăng.

Với **partial unique index**: chỉ enforce unique khi job `pending/claimed/processing`. Sau khi job kết thúc (`failed/done`) → không còn trong index → retry hợp lệ (`/retry` command) tạo được job mới nhờ `attempt_seq` tăng lên.

---

## 4. HTTPS REST API — Claude (Anthropic) và HTTP/2

### 4.1 HTTP/2 Multiplexing

Claude API dùng **HTTP/2**:

```
HTTP/1.1 (tuần tự, không pipelining):
  Request A → [chờ] → Response A → Request B → Response B

HTTP/2 Multiplexing (trên 1 TCP connection):
  Stream 1: Request A ──────────────────────→ Response A
  Stream 3:      Request B ─────────→ Response B
  Stream 5:           Request C ──→ Response C
  [không có head-of-line blocking ở application layer]
```

**Thực tế**: Extraction worker gửi 1 request Claude/lần. HTTP/2 duy trì 1 persistent TCP connection với `api.anthropic.com` → không tốn chi phí TLS handshake cho mỗi tin nhắn.

### 4.2 Streaming Response — Server-Sent Events (SSE)

Claude API hỗ trợ streaming:

```
POST /v1/messages
Headers: Accept: text/event-stream

→ Response stream (từng chunk, không chờ toàn bộ):
data: {"type":"content_block_delta","delta":{"text":"{\n  \"is_listing\":"}}
data: {"type":"content_block_delta","delta":{"text":" true,\n  \"price\":"}}
data: {"type":"content_block_delta","delta":{"text":" \"5 triệu\","}}
...
data: {"type":"message_stop"}
```

**Lợi ích**: Với JSON response dài (extraction schema nhiều field), app bắt đầu parse và validate ngay khi nhận chunk đầu tiên, thay vì chờ toàn bộ response. Giảm "time to first byte" → pipeline tiếp tục sớm hơn.

### 4.3 Request Retry — Phân biệt lỗi retry được và không retry được

```typescript
// utils/retry.ts
function isRetryable(err: unknown): boolean {
  if (err instanceof APIError) {
    return [429, 503, 502, 504].includes(err.status);
    // 429 Too Many Requests → retry sau Retry-After header
    // 503 Service Unavailable → retry với backoff
    // KHÔNG retry: 400 (bad request), 401 (auth error)
  }
  if (err instanceof Error) {
    // Network errors: ECONNRESET, ETIMEDOUT, ECONNREFUSED
    return ['ECONNRESET','ETIMEDOUT','ECONNREFUSED'].includes(err.code ?? '');
  }
  return false;
}
```

---

## 5. Telegram Bot API — Long Polling vs Webhook

### 5.1 Hai mô hình nhận update từ Telegram

**Webhook (Push)**:
```
Telegram Server ──── POST /your-bot-endpoint ────→ App Server
                     [khi có update mới]
Yêu cầu: public domain + HTTPS certificate hợp lệ
```

**Long Polling (Pull)**:
```
App ──── GET /getUpdates?offset=N&timeout=30 ────→ Telegram
App ←─── [server giữ kết nối, response khi có update hoặc timeout 30s]
App ──── GET /getUpdates?offset=N+1&timeout=30 ──→ [lặp lại ngay]
```

**Tại sao dự án này chọn Long Polling?**

| Tiêu chí | Webhook | Long Polling |
|---|---|---|
| Yêu cầu hạ tầng | Public IP + HTTPS cert + domain | Không cần gì thêm |
| Độ trễ nhận update | ~0ms (server push ngay) | ~0-30ms (thực tế gần như instant) |
| VPS không có domain | Phức tạp (reverse proxy, cert) | Hoàn toàn phù hợp |
| Offline handling | Webhook miss sẽ mất | Polling bắt kịp khi reconnect |

**Kết luận**: VPS có IP tĩnh nhưng không cần domain riêng → Long Polling tối ưu. Độ trễ không đáng kể với use case điều khiển thủ công (approve/reject/pause).

### 5.2 HTTP Keep-Alive trong Polling Loop

`node-telegram-bot-api` dùng HTTP Keep-Alive: sau mỗi response, TCP connection không bị đóng, request tiếp theo gửi ngay trên cùng socket → tránh overhead TCP/TLS handshake mỗi 30 giây. Telegram giữ kết nối mở tối đa 30s server-side; nếu không có update → trả `{"ok":true,"result":[]}` sau 30s → app lập tức gửi request mới.

### 5.3 Gửi Notification — Telegram Đảm bảo Delivery

```
App ──── POST /sendMessage { text: "...", reply_markup: {...} } ──→ Telegram API
App ←─── { ok: true, result: { message_id: 456 } }
```

Nếu user offline khi app gửi → Telegram server lưu và deliver khi user online. App **không cần** retry hoặc track delivery — đây là trách nhiệm của Telegram server. Đây khác hoàn toàn với WebSocket trực tiếp (mất kết nối = mất tin nhắn nếu không có ack mechanism).

---

## 6. Browser Automation — Playwright và Chrome DevTools Protocol (CDP)

### 6.1 Kiến trúc mạng của Playwright

Playwright không phải browser — nó là **controller** giao tiếp với Chrome qua **Chrome DevTools Protocol (CDP)**, một giao thức WebSocket JSON-RPC:

```
┌─────────────────────┐    WebSocket (CDP)     ┌─────────────────────┐
│  Node.js App        │◄──────────────────────►│  Chrome Browser     │
│  (Playwright lib)   │  localhost:9222/...     │  (headless)         │
│                     │                         │                     │
│  page.goto(url)     │  {"method":             │  [navigates to URL] │
│  page.click(sel)    │   "Page.navigate",      │  [clicks element]   │
│  page.type(text)    │   "params": {...}}      │  [types text]       │
└─────────────────────┘                         └────────┬────────────┘
                                                         │ HTTPS (TLS)
                                                         ▼
                                                  facebook.com servers
```

**Điểm quan trọng**: Playwright điều khiển Chrome qua WebSocket localhost, còn Chrome tự thực hiện các kết nối HTTPS đến Facebook. App code không trực tiếp "nói chuyện" với Facebook — Chrome làm điều đó thay mặt, với TLS fingerprint như browser thật.

### 6.2 Headless Mode và TLS Fingerprinting

**Vấn đề**: Facebook (và Cloudflare) phân tích **TLS ClientHello fingerprint (JA3 hash)** để phát hiện automation tools. Chromium bundled của Playwright có fingerprint đặc trưng, dễ bị nhận diện.

**JA3 Fingerprinting**: Server tạo MD5 hash từ các trường trong TLS ClientHello (version, cipher suites, extensions, elliptic curves...). Hash này đặc trưng cho từng TLS implementation. Bot detection services duy trì database JA3 hash của các automation tools.

**Giải pháp trong dự án**: Dùng `channel: "chrome"` — Chrome thật được cài trên VPS:
```typescript
const browser = await chromium.launch({
  channel: 'chrome',  // Chrome thật — cùng JA3 fingerprint với người dùng bình thường
  headless: true,
});
```

### 6.3 Persistent Browser Context — Session Persistence qua Mạng

```typescript
const context = await browser.newContext({
  userDataDir: FB_BROWSER_PROFILE_DIR,  // data/fb-browser-profile/
});
```

**`userDataDir` lưu gì?**
- Cookies (session token Facebook → `{ name: "xs", value: "...", httpOnly: true, secure: true }`)
- localStorage / sessionStorage
- IndexedDB (offline data)
- Cache headers (ETag, Last-Modified → giảm bandwidth cho tài nguyên tĩnh)
- Certificate trust store

**Khi app restart**: Browser context load lại toàn bộ state → Facebook không cần đăng nhập lại → không trigger 2FA.

**Rủi ro corrupt**: Nếu process bị kill không gracefully → Chrome đang ghi userDataDir giữa chừng → corrupt. Đây là lý do `shutdown.ts` phải gọi `browserContext.close()` trước `process.exit()`.

### 6.4 Selector Abstraction — Chống Facebook DOM Rotation

**Facebook thay đổi DOM**: Facebook deploy code mới nhiều lần/tuần. CSS class names thường bị obfuscate và rotate. Dùng class selector cứng sẽ break liên tục.

**Selector priority trong `fbSelectors.ts`**:
```typescript
const FB_SELECTORS = {
  compose_button: [
    '[aria-label="Tạo bài viết"]',            // 1. aria-label — ổn định nhất
    '[data-testid="composer-open-button"]',    // 2. data-testid — semi-stable
    'div[role="button"]:has-text("Tạo bài")', // 3. text content — locale-dependent
    '.x1i10hfl[tabindex="0"]',                // 4. CSS class — unstable, last resort
  ],
};
```

**Tại sao `aria-label` ổn định nhất**: Accessibility attributes phải ổn định để screen readers hoạt động — Facebook không thể rotate chúng tùy tiện mà không vi phạm WCAG guidelines. CSS class thì có thể thay đổi bất cứ lúc nào vì chúng là implementation detail.

---

## 7. Quản lý Kết nối và Độ tin cậy Hệ thống

### 7.1 Circuit Breaker Pattern — Phân tích Sâu

Circuit Breaker là pattern quan trọng trong **distributed systems** và **network programming**:

```
Facebook Circuit Breaker States:

  CLOSED ──(phát hiện checkpoint/captcha)──► OPEN
    │                                           │
    │ (user /resume qua Telegram)               │ (Scheduler thấy tripped=true
    └───────────────────────────────────────────┘  → skip ALL posting jobs)

  Không có HALF-OPEN state.
  Lý do: Facebook checkpoint là sự kiện nghiêm trọng cần
  human judgment, không nên auto-test lại — nếu auto-resume
  và bị checkpoint lần 2 → tình huống tệ hơn.
```

**So sánh với Circuit Breaker chuẩn** (trong microservices): Thông thường circuit breaker có HALF-OPEN state để tự test xem downstream service đã recover chưa. Ở đây "downstream" là Facebook account của user — không thể auto-test bằng cách thử đăng bài.

### 7.2 Rate Limiting — Multi-Layer Defense

Hệ thống áp dụng rate limit **nhiều tầng** (defense in depth):

```
Tầng 1 — Zalo batching (30-60s)
  → Gom nhiều message thành 1 listing
  → Giảm số lần gọi LLM API

Tầng 2 — Per-group daily limit (max_posts_per_day)
  → Mỗi group tối đa N bài/ngày

Tầng 3 — Per-group interval (GROUP_MIN_INTERVAL_MINUTES)
  → Giữa 2 bài đăng vào cùng group phải cách ≥ N phút

Tầng 4 — Global daily limit (MAX_POSTS_PER_DAY=15)
  → Tổng tất cả group không vượt 15 bài/ngày

Tầng 5 — Random delay (POST_DELAY_MIN~MAX_SECONDS)
  → Ngẫu nhiên hóa thời gian giữa các action trong 1 lần đăng
  → Human simulation: không ai click đều nhau từng mili-giây

Tầng 6 — Active hours (ACTIVE_HOURS_START~END + jitter)
  → Chỉ đăng 7h–22h giờ VN
  → Đăng rải đều 24/7 = dấu hiệu bot rõ hơn cả tần suất
```

**Lý thuyết Leaky Bucket**: Thiết kế scheduler (1 job/tick, mỗi tick 2 phút) tương đương Leaky Bucket — output rate được kiểm soát bởi tick interval, bất kể bao nhiêu job trong queue. Jobs được xử lý đều đặn, không burst.

### 7.3 Graceful Shutdown — Đóng Kết nối Đúng Cách

```
SIGTERM signal nhận được
        │
        ▼
isShuttingDown = true
        │
        ├──► Scheduler: ngừng pick job mới
        ├──► Zalo listener: ngừng enqueue message mới
        │
        ├──► Chờ posting worker hoàn tất (timeout 30s)
        │
        ├──► browserContext.close()
        │    → Chrome flush disk writes cho userDataDir
        │    → TCP FIN gửi đến CDP WebSocket (localhost)
        │
        ├──► mongoClient.close()
        │    → Drain in-flight queries
        │    → Gửi TCP FIN đến MongoDB Atlas
        │
        └──► process.exit(0)
```

**TCP FIN vs TCP RST**:
- `FIN` (graceful close): "Tôi đã gửi xong dữ liệu, bạn có thể đóng". Phía kia flush buffer, không mất dữ liệu in-flight.
- `RST` (xảy ra khi kill -9): "Connection cắt đột ngột". MongoDB driver phía Atlas không biết connection đã die → phải timeout mới detect → delay xử lý lần sau.

### 7.4 Timezone — Vấn đề Distributed State Không Hiển Nhiên

```
VPS chạy UTC. App cần tính "hôm nay" theo giờ Việt Nam (UTC+7):

VPS 00:00 UTC = 07:00 SA giờ VN
→ daily_counters reset lúc 7h sáng giờ VN (SAI về mặt UX)
→ /stats báo ngày sai
→ MAX_POSTS_PER_DAY reset sai giờ

Giải pháp: TZ=Asia/Ho_Chi_Minh trong .env/systemd
→ mọi Date computation theo giờ VN
→ daily_counters.date = "2026-08-18" (key theo VN date)
```

**Tác động đến Scheduler**: Active hours (7h-22h) cũng phải tính theo VN timezone — không dùng `Date.getHours()` (UTC) mà dùng locale-aware formatting.

---

## 8. HTTP Health Check Server — Expose Network State An Toàn

### 8.1 HTTP Server trong Background Daemon

```typescript
const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    const status = buildHealthStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  }
});
server.listen(HEALTH_CHECK_PORT, HEALTH_CHECK_BIND);
// HEALTH_CHECK_BIND = '127.0.0.1' (default, localhost only)
```

### 8.2 Bind Address và SSH Port Forwarding

**Bind `127.0.0.1` thay vì `0.0.0.0`**:
```
0.0.0.0 → lắng nghe trên TẤT CẢ interface
          → port hở ra internet → ai scan cũng đọc được

127.0.0.1 → chỉ loopback interface
            → chỉ process trên cùng VPS truy cập → an toàn
```

**SSH Port Forwarding để xem từ xa**:
```bash
ssh -L 3100:127.0.0.1:3100 user@vps-ip
# Trên máy local:
curl http://localhost:3100/health
```

Lệnh này tạo **SSH tunnel**: traffic đi qua SSH channel (port 22, đã mã hóa AES) → không cần mở thêm firewall rule, không expose thêm port ra internet.

---

## 9. Tổng hợp: Giao thức Mạng và Vị trí trong Dự án

| Giao thức / Pattern | Module | Vai trò |
|---|---|---|
| **WebSocket** | `zaloClient.ts` | Nhận tin nhắn Zalo real-time (full-duplex, persistent) |
| **HTTP Long-Polling** | `zaloClient.ts` / `telegramBot.ts` | Nhận update từ server khi WebSocket không khả dụng / Telegram |
| **DNS SRV + TLS 1.3** | `mongoClient.ts` | Kết nối MongoDB Atlas an toàn, HA-aware DNS |
| **TCP Connection Pool** | `mongoClient.ts` | Tái sử dụng TCP connections, giảm handshake overhead |
| **Atomic Write (MongoDB Wire Protocol)** | `jobQueue.ts` | Giải quyết race condition claim job qua mạng |
| **Partial Unique Index** | `jobQueue.ts` | Idempotency cho network retry |
| **HTTP/2 + SSE Streaming** | `claudeClient.ts` | Claude API: multiplexing, streaming response |
| **HTTP REST POST** | `notifyEvents.ts` | Gửi thông báo Telegram (server-guaranteed delivery) |
| **WebSocket (CDP)** | `fbBrowser.ts` | Playwright ↔ Chrome control channel (localhost) |
| **HTTPS (TLS fingerprint: Chrome)** | `fbPoster.ts` | Chrome kết nối Facebook với fingerprint người dùng thật |
| **TCP Server (localhost)** | `healthServer.ts` | HTTP health endpoint, bind 127.0.0.1 |
| **Exponential Backoff + Jitter** | `reconnectManager.ts` | Zalo reconnect, chống thundering herd |
| **Circuit Breaker (no HALF-OPEN)** | `scheduleLogic.ts` | Dừng toàn bộ posting khi phát hiện FB block |
| **Multi-Layer Rate Limiting (Leaky Bucket)** | `scheduleLogic.ts` | Kiểm soát output rate — defense in depth |
| **TCP Graceful Close (FIN)** | `shutdown.ts` | Đóng kết nối sạch sẽ, tránh data loss |
| **SSH Port Forwarding** | (VPS ops) | Truy cập health endpoint an toàn từ xa |

---

## 10. Kết luận Học thuật

### Những vấn đề Lập trình Mạng được giải quyết

1. **Persistent Connection Management**: WebSocket cho Zalo, Connection Pool cho MongoDB, Keep-Alive cho Telegram API — tất cả đều nhằm tối ưu hóa TCP connection lifecycle và giảm overhead handshake.

2. **Reliability on Unreliable Networks**: Exponential backoff với jitter, circuit breaker, idempotency key, partial unique index, và graceful shutdown giải quyết thực tế rằng mạng không bao giờ 100% tin cậy.

3. **Security trong giao tiếp mạng**: TLS everywhere, bind localhost cho internal services, SSH tunnel cho remote access, cookie/session management đúng cách (HttpOnly, Secure).

4. **Race Conditions trong Distributed Operations**: Ngay cả single-process cũng có race condition khi nhiều async coroutines cùng đọc-ghi qua mạng — giải quyết bằng atomic MongoDB operation (`findOneAndUpdate`).

5. **Protocol Selection Trade-offs**: WebSocket vs Long-Polling vs Short-Polling; Webhook vs Long-Polling — mỗi lựa chọn có trade-off rõ ràng về infrastructure requirement, latency, và reliability.

6. **Network Fingerprinting và Evasion**: TLS JA3 fingerprinting, User-Agent, Human behavior simulation (random delay, active hours) — ứng dụng thực tế của hiểu biết về cách các hệ thống phát hiện bot hoạt động ở tầng mạng.

7. **Distributed State và Timezone**: Đồng bộ hóa state (MongoDB Atlas ↔ VPS app) và xử lý timezone trong hệ thống phân tán — vấn đề thực tiễn thường bị bỏ qua trong lý thuyết nhưng gây bug nghiêm trọng khi deploy.

### So sánh với các mô hình kiến trúc mạng kinh điển

| Mô hình kinh điển | Áp dụng trong dự án |
|---|---|
| **Client-Server** | App (client) ↔ MongoDB Atlas, Claude API, Telegram API, Facebook (qua Chrome) |
| **Event-Driven / Reactive** | Zalo Listener: event-driven (WebSocket push) thay vì polling liên tục |
| **Producer-Consumer** | `post_jobs` collection = message queue đơn giản, workers poll từ DB |
| **Publish-Subscribe** | Telegram Bot nhận command (subscribe), app publish notification |
| **Proxy Pattern** | Playwright là proxy giữa app logic và Facebook HTTP layer |
| **Bulkhead Pattern** | Zalo circuit breaker tách biệt với FB circuit breaker — failure của 1 bên không ảnh hưởng bên kia |

---

*Tài liệu này là phần mở rộng học thuật của [`plan.md`](./plan.md). Toàn bộ thiết kế kỹ thuật và quyết định triển khai chi tiết nằm trong tài liệu gốc.*
