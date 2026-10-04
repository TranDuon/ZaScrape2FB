# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Personal automation agent: listens to room-rental listings posted in Zalo group chats, extracts
structured data via Gemini, stores it in MongoDB, auto-composes multiple post variations, and
posts them to Facebook Groups via Playwright — end to end, with a Telegram bot for review/control.

- **Full architecture, schema, and phased roadmap**: [plan.md](plan.md) — read this before making
  structural changes. It documents decisions (and the reasoning behind them) that aren't obvious
  from the code alone: TTL retention windows, idempotency key design, timezone handling, etc.
- **User-facing setup/usage**: [README.md](README.md)
- Both `plan.md` and code comments are written in Vietnamese; this is intentional (sole user is a
  Vietnamese speaker) — match that convention in comments/logs within `src/`.

## Commands

```bash
npm install
cp .env.example .env          # fill in MONGODB_URI (Atlas, mongodb+srv://) and GEMINI_API_KEY

npm run dev                   # tsx watch — main entrypoint, requires a saved Zalo session
npm run dashboard             # management UI at 127.0.0.1:3200; runs + supervises the agent as a child
npm run dashboard:stop        # graceful: dashboard stops the agent, then exits
npm run autostart:install     # Windows: Startup-folder shortcut → hidden dashboard at every logon
npm run autostart:remove
npm run typecheck             # tsc --noEmit, no separate build step (tsx runs TS directly)

npm run login:zalo            # one-time interactive QR login, writes data/zalo-session/
npm run list:threads          # list all Zalo groups + IDs, to populate ZALO_ALLOWED_THREAD_IDS
npm run check:db              # verify Atlas connection + index creation
npm run check:listings        # inspect recently saved listings in MongoDB
npm run check:stuck [hours]   # find only what's WRONG: stuck listings, failed jobs, unknown posts,
                               # tripped breakers. Exits 1 if anything found. Main soak-test tool.
npm run inject -- --list      # list injectable sample listings
npm run inject -- 0           # inject a listing as if Zalo just received it (see note below)
npm run reset-db              # wipe listings for a clean local test run
npm run cleanup:images        # delete images/screenshots past retention (see IMAGE_RETENTION_DAYS)
npm run cleanup:images -- --force   # ignore retention age, delete everything eligible by status now
npm run backup:sessions       # snapshot Zalo session + FB browser profile into SESSION_BACKUP_DIR

npm test                      # vitest, test/unit/*.test.ts: messageBatcher/messageParser, confidenceGate,
                               # numberParser, scheduleLogic, time, activeWindows, llmBatch (index mapping),
                               # batchCollector, areaMatcher, composeBudget, composedText,
                               # pendingApproval, postingOnce, dailyQuota, inboxParser,
                               # directMessageAlert — no API
npm run test:watch            # vitest in watch mode
npm run test:extractor        # runs test/fixtures/sample-messages.json through real Gemini calls
npm run test:jobqueue         # concurrent-claim + retry-after-failure, against real Atlas, self-cleaning
npm run test:composer         # end-to-end compose + schedule + recompose, real Gemini + Atlas, self-cleaning
npm run test:facebook         # checkpoint detection + selector fallback + rate limiting, offline fixtures
npm run test:telegram         # sends a real Telegram message + hits the health endpoint
npm run telegram:chatid       # resolve TELEGRAM_CHAT_ID after messaging the bot

npm run login:facebook                        # one-time manual FB login (requires FB_HEADLESS=false)
npm run test:fbpost -- <groupId> --dry-run    # walk every posting step but never click Post
npm run test:fbpost -- <groupId>              # actually publish one post to one group

npm run seed:groups -- list                              # Facebook Group CRUD (see src/models/group.model.ts)
npm run seed:groups -- add "<name>" "<url>" [max/day] [min-interval-min]
npm run seed:groups -- toggle <id>
npm run seed:groups -- remove <id>
npm run seed:groups -- areas <id> "Cầu Giấy,Nam Từ Liêm"   # khai báo tay khu vực nhóm phục vụ
npm run seed:groups -- areas <id> --auto                   # quay lại suy khu vực từ tên nhóm
```

Pure-logic tests live under `test/unit/*.test.ts` and run on `vitest` (`npm test` /
`npm run test:watch`, config in `vitest.config.ts`). `test:extractor`, `test:composer`,
`test:jobqueue`, `test:facebook`, `test:telegram` stay as plain `tsx` scripts on purpose — they hit
real Gemini/Atlas/Telegram/Facebook and assert internally, exiting non-zero on failure
(`process.exit(1)`), printed as PASS/FAIL lines; migrating those to vitest would add ceremony
without adding coverage, since they already only make sense run manually with real credentials.
`test:facebook` in particular already covers `rateLimiter`/`checkpointDetector` against real Atlas +
a real headless Chrome — it was deliberately left as-is rather than force-converted to mocked vitest
tests, since it's a working, previously-verified check.

All npm scripts that print to the console have a matching `pre<script>` hook running
`scripts/ensure-utf8-console.mjs`, which runs `chcp 65001` only on `win32` (no-op elsewhere,
including the production Linux VPS). This exists solely to fix garbled Vietnamese output in
Windows cmd.exe/PowerShell during local dev — don't remove it without adding a new script the same
way, or Windows console output breaks again.

## Architecture

### Pipeline (full, end to end — all phases in `plan.md` implemented)

```
Zalo group chat message
  → messageParser (text vs image, prefers HD image URL from params over href)
  → messageBatcher (a TEXT message is the room boundary; images append to the open batch.
                     Idle window and hard cap are only safety nets — see "Batching" below)
  → messageListener applies the per-thread daily intake cap, then persists to `listings`
    (status: received) + downloads images to disk
  → enqueue extract_listing job
  → extractionWorker claims job, calls Gemini (geminiClient + extractor.ts)
  → confidenceGate routes: not-a-listing → ignored | confidence below threshold → needs_review
    | else → ready (auto-enqueues compose_post). Missing fields are recorded, never blocking.
  → composerWorker generates N distinct variations in ONE Gemini call, sets listing to queued,
    and creates one post_to_group job per eligible group with staggered scheduled_at
  → cron tick (scheduleLogic.runCycle) claims at most ONE post_to_group job per tick
  → postingWorker passes rateLimiter, drives Playwright to publish the job's composed_text
    snapshot, and writes post_history
```

All phases from `plan.md` are implemented, phases 1-9. Deployment artifacts live in [deploy/](deploy/)
(systemd unit and pm2 config — use one, never both) and operational procedures in
[RUNBOOK.md](RUNBOOK.md). The only thing left of the single-account build is what code can't do:
running it live for several days on the VPS and watching for stuck states.

**Phase 10 — VPS deploy (Google Cloud) + multi-Facebook-account routing is planned but not started**,
see the "Deploy VPS + đa tài khoản Facebook" section near the end of `plan.md` for the locked-in
decisions (Google Cloud, fixed area→account routing on `areaMatcher.ts`, deploy-then-soak-then-expand
ordering) before re-planning the detailed steps.

### Job queue is the coordination primitive, not a library

`src/jobs/jobQueue.ts` implements a hand-rolled MongoDB-backed queue (`post_jobs` collection):
`enqueueJob` (idempotent insert, silently no-ops on duplicate key), `claimNextJob` (atomic
`findOneAndUpdate`, this is what makes it safe to eventually run multiple worker processes),
`completeJob`/`failJob` (failJob computes backoff and requeues until `max_attempts`), and
`requeueStaleJobs` (recovers jobs stuck in `processing` from a process that died — called once at
startup in `src/index.ts`, not on a timer). Every future worker (composer, poster) should follow
the same claim/complete/fail shape rather than inventing new queue logic.

Idempotency: `idempotency_key = hash(type + listing_id + group_id + attempt_seq)` has a **partial**
unique index (only enforced while `status` is pending/claimed/processing — see `src/db/indexes.ts`),
so retrying a finished job by bumping `attempt_seq` is intentionally allowed.

**`type` must be in that hash — this was a real, severe bug until 2026-08-21.** Without it,
`extract_listing` and `compose_post` for the same listing (both have `group_id: null`,
`attempt_seq: 0`) hash identically. `extractionWorker.processJob()` enqueues the `compose_post` job
*before* calling `completeJob()` on the `extract_listing` job it's currently handling — so at that
moment the original job is still `processing`, the partial unique index is still enforcing it, and
the `compose_post` insert hits a duplicate-key error that `enqueueJob` swallows silently (logged at
`debug`, indistinguishable from an intentional dedup). The result: every listing that ever reached
`ready` through the automatic path never actually got a `compose_post` job — discovered only when
real Zalo data and `scripts/inject-listing.ts` ran the *whole* pipeline for the first time, since
`test/composer.manual.ts` always staged jobs manually on fresh listing IDs and never exercised this
same-listing, same-tick collision. `test/jobQueue.integration.ts`'s
`testDifferentTypesDontCollide` reproduces the exact sequence (claim `extract_listing` → enqueue
`compose_post` for the same listing while it's still `processing`) as a permanent regression check.

**`requeueStaleJobs` treats `post_to_group` differently from every other job type, and this is the
single most important invariant in the queue.** Extraction/compose jobs stuck in `processing` are
requeued to `pending` — rerunning them just costs Gemini quota. Posting jobs are **never** requeued;
they're marked `failed` and stop there. The reason: the process can die *after* Playwright clicked
Post but *before* `completeJob` ran, so the post may already be live on Facebook. Requeueing would
publish the same text to the same group twice — unmistakably bot-like and impossible to undo. The
orphaned `post_history` record left at `attempting` is the evidence trail, and
`src/maintenance/stalePostReaper.ts` is what surfaces it to the user. Never "fix" this by making the
sweep uniform across job types.

`test/jobQueue.integration.ts` proves this against real Atlas (not mocked): 10 concurrent
`claimNextJob` calls on one pending job resolve to exactly 1 non-null result, and enqueuing with a
bumped `attempt_seq` after a job reaches `status: "failed"` succeeds where the same `attempt_seq`
would have been blocked. Run it after touching claim/enqueue logic — it inserts/deletes real
documents scoped to a throwaway `ObjectId`, cleaned up in a `finally` block.

### You cannot trigger the pipeline by messaging Zalo yourself

`messageListener` drops `message.isSelf` early, so sending a listing into a watched group from the
agent's own Zalo account produces nothing. That makes on-demand testing impossible without waiting
for someone else to post, which is why `scripts/inject-listing.ts` exists: it writes a `listings` doc
in exactly the shape `persistBatch` produces and enqueues `extract_listing`, replacing only the Zalo
ingestion step. Everything downstream (Gemini extraction → confidence gate → composer → scheduler →
Playwright) runs identically to production. Injected listings use `source.thread_id: "test-injected"`
and `sender_name: "TEST (tiêm tay)"` so they're trivially separable from real traffic, and their
`message_ids` carry a timestamp so re-injecting the same fixture doesn't trip the dedup unique index.

### Batching splits on TEXT messages, not on time gaps

**A text message is the boundary between two rooms.** `MessageBatcher.addText` flushes the open
batch and opens a new one; `addImage` appends to whatever batch is open. Time is now only a safety
net (idle window closes the final batch when no further text arrives; hard cap prevents an
indefinitely open batch).

This replaced a purely time-based rule (flush after 45s of silence) that was wrong against real
traffic. Measured on a real message dump stored in MongoDB: **149 messages in ~4 minutes, 20 texts
and 129 images, interleaved as a perfectly regular `1 text + N images` repeated 20 times.** The
time-based rule produced ONE listing containing all 20 rooms sharing ONE image folder — nothing
could be split apart afterwards, and Gemini (correctly) returned `is_listing: false` with
"gộp nhiều phòng ở nhiều địa chỉ", so all 20 real rooms were silently lost. Bulk-dumping a whole
catalogue in minutes is normal behavior for the agents being monitored, not an edge case.

Three details that are easy to get wrong:

- **What splits a batch is a short text is decided by whether the open batch already has images,
  not by the text's length alone.** Both of these shapes occur in real traffic and they need
  opposite handling:
  - `[full text][images…][short label][images…]` — the label *is* a new room, so it must split.
  - `[full text][short text][images…]` — the short text is an afterthought about the room just
    posted, so it must **not** split.

  `addText` therefore only treats a short text (≤ `LABEL_MAX_LENGTH`, 80 chars) as a room boundary
  when the open batch already holds at least one image; otherwise it appends to the open batch.
  Getting this wrong cost every image of every listing on 2026-08-23: the afterthought closed the
  room's batch while it still had 0 images, the label path then declined to open a replacement, and
  all 20 photos that followed hit `addImage` with nothing open. The symptom in MongoDB was
  `created_at` landing *before* `raw_message.received_at` (an instant flush, not a 45s idle one).
- **A short label arriving with no batch open is still discarded, along with the images behind
  it** — `addImage` drops images when nothing is open. That is deliberate (a bare room code has no
  address, so the composed post would be useless) but it *is* a data-loss path, which is why it
  logs at WARN.
- **Images arriving before any text** don't get cut off into a separate textless batch: if the open
  batch has no text yet, an incoming text joins it rather than starting a new one.

`addText`/`addImage` still take an explicit `timestamp` (the Zalo message's own `ts`, not
`Date.now()`) for the idle/hard timers, since Zalo replays history in bursts where arrival time is
meaningless.

Because `messageListener.persistBatch` derives the image folder from `messageIds[0]`, each room now
automatically gets its own folder at download time — no separate change was needed for that.
`test/unit/messageBatcher.test.ts` replays the exact real 149-message sequence and asserts it splits
into 20 batches with all 129 images preserved.

That initial folder name (`threadId-firstMessageId`) is opaque on disk — you can't tell which room
it is without cross-referencing MongoDB. `mediaDownloader.relocateListingImages()` fixes this after
the fact: once `extractionWorker.processJob` has the parsed address, it renames the directory to
`<địa chỉ đã làm sạch>-<6 ký tự cuối của listingId>` (the id suffix guards against two listings at
the same address colliding) and rewrites every `images[].local_path` in the same DB update that
writes `parsed_data`. Listings that end up `ignored` or without an address keep the opaque
thread/message name, since there's nothing meaningful to rename to. The rename never throws — a
locked directory or cross-device error just logs a warning and leaves the old path in place, because
losing images over a cosmetic rename would be a worse trade than living with an unreadable folder
name.

### An attachment must never be parsed as `kind: "text"`

`messageParser.parseIncomingMessage` classifies each Zalo message, and the batcher treats **a text
message as the boundary between two rooms**. Those two facts combine into a sharp edge: a photo
misread as text doesn't just lose that photo, it *closes the open batch*, and since a photo's
`title` is a filename (shorter than `LABEL_MAX_LENGTH`) it's then discarded as a room label —
taking every image that follows with it.

That is exactly what happened on 2026-08-23: every listing landed in MongoDB with `images: 0`,
`data/images/` was completely empty, and the giveaway was that each listing's `created_at` was
~0.5s *before* its `raw_message.received_at` — batches were being closed the instant the next
message arrived instead of after the 45s idle window, which only `addText` can do. Images had
worked two days earlier (25 successful downloads in that day's log), so the parser's single
`msgType.includes("photo")` test had stopped matching.

Image detection therefore has three independent paths — `msgType`, an `hd`/`normal`/`origin` URL
inside `params`, and an image file extension on the URL — and when all three miss, the result is
`kind: "other"` (harmlessly ignored), **never** `kind: "text"`. Keep that invariant: the
title/description → text fallback exists only for link/recommend cards, and letting a media
attachment reach it silently destroys real listings.

The other half of the fix was visibility. An unreadable attachment now logs at **WARN** with
`msgType` and the content object's keys, and `addImage` dropping an orphan image logs at WARN too.
Both were at `debug` while `LOG_LEVEL` defaults to `info`, which is why a total loss of every
image produced not one line of evidence. Anything that discards real listing data belongs at WARN.

### Extraction: two schemas, on purpose

`src/llm/extractor.schema.ts` defines the field set **twice**: `GEMINI_RESPONSE_SCHEMA` (Google's
`Schema` type, sent as `responseSchema` for structured output) and `extractionSchema` (zod, used to
re-validate whatever Gemini actually returns). Do not assume structured output means the response
is trustworthy — Gemini can still return wrong types or omit required fields; zod is the real
contract enforcement layer and is what downstream code depends on (`ExtractionResult` type is
inferred from the zod schema, not the Gemini schema).

Money/area fields go through `src/llm/numberParser.ts` (`parseLooseNumber`) rather than bare
`Number()`, because Vietnamese numeric formatting is the reverse of English (`.` = thousands
separator, `,` = decimal) and the model occasionally returns formatted strings despite being
instructed to return numbers. Utility prices (electricity/water/wifi) are deliberately kept as raw
strings (e.g. `"35k/khối"`) rather than parsed — units aren't consistent enough across listings to
normalize safely.

`is_listing` classification and field extraction happen in a single Gemini call (see
`extractor.schema.ts` and the system prompt in `extractor.ts`), not two separate calls — this is a
cost/latency decision, not a capability limit.

### Composer asks for exactly as many captions as there are groups — per listing

`POST_VARIATION_COUNT` is a **ceiling, not an order quantity**. The count actually requested is
`min(groups this listing will be posted to, POST_VARIATION_COUNT)`, so at
`MAX_GROUPS_PER_LISTING=1` the model writes exactly one caption per room and nothing is wasted.
There is no separate "single caption" mode to add — setting `POST_VARIATION_COUNT=1` already forces
one caption reused across every group, at the cost of posting identical text to several groups,
which is the cross-group duplicate the variation mechanism exists to prevent.

The count is per **listing**, not per batch. It used to be
`Math.max(...targeted.map(i => i.targets.length))` — one number for the whole batch — which made
every room in a batch pay for the room with the widest coverage. District coverage is very uneven
(Thanh Xuân 10 groups, Hà Đông 1), so a mixed batch of 1+3+2 groups generated 9 posts to use 6:
**33% of composer output tokens thrown away**, and output is the expensive side of this call.
`ComposerItem.variationCount` now carries the number per room and the prompt states it inside each
`=== PHÒNG #n ===` block rather than once in the header.

### Composer: one call, N variations, and two places content lives

`src/llm/composer.ts` asks Gemini for all variations in a **single** call rather than N calls. This
is not only cheaper: when the model sees the other variations in the same response it actually
writes different ones, whereas N independent calls with the same prompt produce near-identical
text. Unlike extraction, the composer runs at `temperature: 1` — variety is the point.

Content deliberately lives in two places, and the distinction matters:
- `listing.composed_post` — the canonical version, the one a human reviews/edits over Telegram.
- `post_jobs.payload.composed_text` — an immutable per-group snapshot fixed when the job is created.
  The posting worker must publish this snapshot and never re-read the listing, so what lands on
  Facebook matches exactly what was approved.

`src/listings/recompose.ts` implements the `queued → ready` reverse path used when a user edits an
already-queued listing: it cancels only `pending` post jobs (never `processing` — Playwright may be
typing right now — and never `done`, since a published post cannot be recalled), returns the
counts so the user can be told precisely how many groups the edit actually affects, then re-enqueues
`compose_post`.

Contact details on the post come from `resolveContact()` in `composer.prompts.ts`:
`AGENT_CONTACT_NAME`/`AGENT_CONTACT_PHONE` override whatever contact the original Zalo message
carried, because the user is reposting other people's listings and wants their own number on the ad.

### The caption voice is an account-safety setting, not a style preference

`COMPOSER_SYSTEM_INSTRUCTION` went to **`v2` on 2026-08-27** because too many posts were being held
for group moderation instead of publishing. v1 cast the model as *"môi giới phòng trọ chuyên
nghiệp"* and prescribed an all-caps headline, a numbered `TIÊU ĐỀ / THÔNG TIN CHÍNH / LIÊN HỆ`
template and 4–6 trailing hashtags — a shape group spam filters match on directly. v2 casts it as a
person subletting their own room, writing under 150 words in first person (`mình`).

**`v3` on 2026-09-15** (user's request) went further: **no prices at all** on the post, and a
plainer, shorter voice — under 70 words, 3–5 short lines, at most 2 emoji, pick only the points worth
saying rather than listing everything. The no-price rule is enforced in **two** places, on purpose:
the prompt forbids any money figure (and vague substitutes like "giá hợp lý"), and
`describeListing()` no longer sends `price_vnd`, `deposit_vnd`, `deposit_terms` or any
`utilities.*` field to the model at all — a model that never sees a number cannot leak it. Prices
still live in `parsed_data` (Telegram `/status`, review). The only remaining leak path is free text
(`notes`, `other_rules`) that happens to contain a price, which the prompt tells the model to drop.

Four rules carried over from v2 are load-bearing and shouldn't be softened back:

- **A banned-phrase list**, because these are what the filters key on: `giá rẻ`, `hotline`,
  `cam kết`, `inbox ngay`, `liên hệ zalo`, `siêu phẩm`, `chính chủ 100%`, and **`cọc`**. (In v2 the
  deposit was still stated as `đặt trước 1 tháng`; v3 drops money entirely.)
- **No line in ALL CAPS, including district names.** This doubles as a fix for the mention-typeahead
  incident (see "Facebook automation"): `HOÀNG MAI` is exactly the kind of token Facebook offered to
  turn into a tag of a stranger.
- **Hashtags capped at 2, empty preferred.** The Gemini schema says so in its `description`, and
  `assemble()` in `composer.ts` already renders an empty array as no trailing block, so this needed
  no code change. A hashtag footer is the single clearest "this is an ad" signal left.
- **Accuracy still overrides voice.** "Only use the data provided, omit what's missing, never invent
  and never write đang cập nhật" survived from v1 unchanged — a friendlier tone must not become
  licence to embellish.

Verified with one real Gemini call on a sample listing before shipping: both variations came back at
119/122 words, zero banned phrases, zero all-caps lines, one emoji, no hashtags, the phone plain on
its own line, and the two genuinely different from each other. Re-run that check when editing this
prompt — the failure mode here is silent, since a post that reads fine to us can still be the one
the group filter holds.

### Gemini model availability changes without warning

Models disappear on Google's schedule, and **`ai.models.list()` is not proof a model is callable** —
dead models keep appearing in the listing. Only a real `generateContent` call settles it (include an
image part when the extractor is affected; vision support must be verified separately).

Probed 2026-08-21 with real calls: `gemini-3.5-flash`, `gemini-3.5-flash-lite`,
`gemini-3.1-flash-lite` alive; `gemini-2.0-flash`, `gemini-2.0-flash-lite`, `gemini-2.5-flash`,
`gemini-2.5-flash-lite` all 404. That probe found a latent bug — `FALLBACK_MODEL` in
`geminiClient.ts` was `gemini-2.0-flash-lite`, already dead, so the 503-fallback path could never
have worked. It is now `gemini-3.5-flash-lite`. **The fallback must always be a different model from
the primary**, because free-tier quota is per-model (below), so falling back to the same model buys
nothing.

### Quota is per-day and per-model, and the budget math drives the design

The free tier allows **20 `generateContent` calls per day per model**
(`quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier`), metered per model — which is why
`FALLBACK_MODEL` must differ from the primary, and why `geminiClient.ts` keeps a module-level
`exhaustedUntil` map (until the next Pacific midnight) so later calls skip a known-exhausted model
up front instead of spending a request to rediscover it.

**The arithmetic is what forced batching.** Unbatched, each listing costs 2 calls (extract +
compose), so 20/day/model was ~10 listings per model per day. That collides directly with the
text-boundary batching change: a single bulk Zalo dump that used to be 1 listing (2 calls)
correctly splits into ~20 listings, which unbatched would be ~40 calls — one dump exceeding a full
day of quota. With request-level batching (previous section) the same dump costs ~4 extract calls +
~7 compose calls at default batch sizes. Any further work on call volume should start from this
arithmetic, and note that raising `POST_VARIATION_COUNT` or adding groups multiplies the compose
side specifically.

### Gộp lô lời gọi Gemini: the quota unit is the *request*, not the token

Free-tier and prepay quotas both meter **`generateContent` calls**, so putting N listings in one
call multiplies throughput by N at essentially the same token cost. Both LLM steps batch:
`extractListings()` (N listings, one call) and `composePosts()` (N listings × M variations, one
call). `src/jobs/batchCollector.ts` is the shared accumulation window — it claims jobs as soon as
it sees them, then holds them for up to `LLM_BATCH_WINDOW_MS` (default 5 min) waiting for more,
running early once `EXTRACTION_BATCH_SIZE`/`COMPOSE_BATCH_SIZE` is reached.

**Results are matched back by an explicit `index` field, never by array position.** The model is
told to copy the `=== TIN #n ===` / `=== PHÒNG #n ===` number into each item, and both mappers
build a `Map<index, item>` and drop out-of-range/duplicate indexes. Position-matching would fail
silently and catastrophically: a reordered response would attach one room's price and phone number
to a different room's address, and that composed post goes straight to Facebook. This is what
`test/unit/llmBatch.test.ts` exists to protect — it mocks `generateJson` and feeds back
deliberately shuffled, missing, duplicated, and out-of-range indexes.

Failures are isolated at two levels, and the distinction is what makes batching safe to use:
- **Whole-call failure** (network, quota, unparseable JSON) → every job in the batch goes through
  `failJob` and retries independently, keeping its own `attempts` count.
- **Single-item failure** (model skipped one, one item fails zod) → only that job retries; the
  other listings in the batch are already written and continue down the pipeline. One bad listing
  must never take four good ones down with it.

Two batching-specific constraints worth keeping in mind:
- **Extraction interleaves text and images in one `parts` array** (`generateJson` accepts `parts`
  for exactly this). Each listing's images must follow that listing's text block — hoisting all
  text then appending all images is the reliable way to make the model misattribute photos.
  `EXTRACTION_BATCH_MAX_IMAGES` is a cap on the *whole batch*, divided evenly, so a 5-listing batch
  doesn't ship 20 images in one request.
- **Compose is the truncation-prone side**: one call must emit `COMPOSE_BATCH_SIZE × group count`
  full posts, so its default batch size is lower (3) than extraction's (5). A truncated response is
  invalid JSON and fails the whole batch, so both JSON-parse error paths log `batch_size` and
  `output_length` and name the env var to lower — don't replace that with an automatic
  fall-back-to-individual-calls path, which could silently burn a whole day's quota.

`staggeredSchedule` accumulates its offset **across** the batch rather than resetting per listing;
otherwise composing 3 listings at once would schedule all three first-group posts inside the same
few minutes, defeating the spacing it exists to create.

`runExtractionOnce()`/`runComposerOnce()` still exist as `windowMs: 0, maxSize: 1` wrappers so
manual scripts (`test/composer.manual.ts`, `test/extractor.manual.ts`) don't sit through a 5-minute
window; `extractListing()`/`composePost()` are batch-of-1 wrappers for the same reason. There is
only one real code path.

### A 429 from Gemini means one of three different things

`geminiClient.ts` splits them because the correct response differs completely:
- **Per-minute rate limit** → short backoff works (`RETRYABLE_STATUS`).
- **Daily per-model quota** (`isDailyQuotaError`, matches `PerDay` in `quotaId`) → retrying this
  model is useless until Pacific midnight; switch to `FALLBACK_MODEL` immediately without sleeping,
  since quota is per-model.
- **Prepay credits depleted** (`isCreditsDepletedError`, matches `credits are depleted`) → nothing
  helps: not waiting, not switching models, since credits are project-wide. Fail immediately with a
  message naming the top-up page. Google sends **no `quotaId`** for this one, which is why it must
  be matched on the message text and why it has to be checked *before* the daily-quota branch.
  Without this case it burned ~5 backoff attempts on the primary and ~5 more on the fallback — about
  two minutes per job — to reach a conclusion available from the first response.

### Confidence gate blocks on only two things

`src/llm/confidenceGate.ts` checks `is_listing` first (a chat message or promo banner is `ignored`
immediately, without asking whether it has a price), then `confidence` against
`CONFIDENCE_THRESHOLD`. That's all that can send a listing to `needs_review`.

**Required-field gating was deliberately removed.** It used to force `needs_review` when
`price_vnd`, an address, or a contact was missing, which blocked most real traffic — Zalo listings
rarely carry all three in one message. The `contact` rule was worse than merely strict: it was
always meaningless, because `resolveContact()` in `composer.prompts.ts` overwrites contact details
with `AGENT_CONTACT_NAME`/`AGENT_CONTACT_PHONE` anyway (the user reposts other people's listings
under their own number). A real listing was observed stuck at `needs_review` with reason
"Thiếu thông tin bắt buộc: contact" for a field that gets discarded downstream.

`missing_required_fields` is still computed and stored for `price_vnd`/`address` — it's useful
context in `/status` — it just no longer blocks. The confidence threshold carries the quality load
now, and does it well: bulk "many rooms, many addresses" messages come back with confidence ~0.2 and
land in `ignored` on their own.

### Two pacing models coexist, on purpose

Extraction and composing run as poll loops (`startExtractionWorker` / `startComposerWorker`): when
they finish a job they immediately look for the next one, because doing Gemini work faster is purely
good. Posting does **not** work that way — it is driven by `src/scheduler/cronRunner.ts`, where each
cron tick handles **at most one** job. That single-job-per-tick rule is what creates natural spacing
between posts without blocking the event loop on sleeps. `node-cron`'s `maxRandomDelay` adds jitter
so posts don't land on exact clock boundaries, and `noOverlap` prevents a slow post (tens of seconds
of Playwright work) from having a second tick open a second browser on top of it.

Because of this split, `startPostingWorker` in `postingWorker.ts` exists but is **not** wired into
`src/index.ts`; the scheduler calls `runPostingOnce` directly. Prefer extending `runCycle` over
re-introducing a poll loop for posting.

**The cron interval IS the spacing between posts — it is not a polling frequency.** Because
`runCycle` claims at most one job per tick, `SCHEDULER_TICK_CRON` sets a hard floor on the gap
between two consecutive posts no matter how large the backlog of due jobs is. It was `*/2` until
2026-08-25, which let a backlog drain at one post every two minutes: the account posted at 14:47,
14:51, 14:57, 14:59 — four posts in twelve minutes — and Facebook answered with
"chúng tôi giới hạn tần suất bạn đăng bài", blocking the 11th post of the day even though
`MAX_POSTS_PER_DAY` was 20 and only 10 had gone out. **The burst rate, not the daily total, is what
tripped the spam filter.** It was raised to `*/15`, then to `*/20` (below).

**But the tick is only the floor — `COMPOSE_STAGGER_*` is what sets the actual cadence, and it is
the stronger lever of the two.** Simulated over 4,000 days (10 posts, 8h–22h window), changing only
the stagger from 15–45 to 45–105 minutes moves every metric that matters, while changing only the
tick moves almost nothing:

| | min gap | mean gap | span | max posts/hour | distinct minute-of-hour |
|---|---|---|---|---|---|
| tick 15, stagger 15–45 (old) | 14 min | 30 min | 4.5 h | 5 | 4 |
| tick 15, stagger 45–105 | 44 min | 75 min | 10.8 h | 2 | 4 |
| tick 20, stagger 45–105 (10/day, until 2026-09-15) | 39 min | 75 min | 10.7 h | 2 | 3 |
| tick 60, stagger 45–105 | 59 min | 75 min | 10.2 h | 2 | **1** |

`COMPOSE_STAGGER_MIN_MINUTES` must stay at or above the tick interval. It only sets `scheduled_at`,
so a value below the tick doesn't make posts any closer together — the tick still gates them — it
just leaves jobs permanently overdue, which hides real backlog from anyone reading `scheduled_at` to
judge whether the queue is keeping up.

**Widening the tick past ~20 minutes is counterproductive, which is not obvious from the arithmetic.**
Every post lands on a tick boundary, so a coarser tick means *fewer distinct minute values across the
whole day* — at an hourly tick every post goes out at the top of the hour, which is a machine
signature in itself no matter how irregular the gaps are. It also delivers fewer posts (9.2 of 10 vs
9.6), since a coarse grid wastes more of the window. The tick's real job is bounding a **backlog**
drain (breaker cleared, power loss, jobs all overdue at once), where it is the only thing that
applies: 15 min → 4 posts/hour, 20 min → 3, 30 min → 2.

**Only use divisors of 60.** Cron's minute field makes `*/45` fire at :00 and :45, so gaps alternate
45 min / 15 min — it would still permit two posts 15 minutes apart, defeating the point.

`maxRandomDelay` is 5 minutes, and it is what breaks the clock pattern the tick creates: 45 seconds
of jitter yielded 3 distinct minute values per day, 5 minutes yields 15. The binding constraint is
**floor = tick − jitter** (20 − 5 = 15 minutes here) — re-derive it whenever either changes, and
never let jitter grow until it eats the floor the tick exists to guarantee.

**The stagger range is paired with the daily cap and must be re-derived with it.** At 10 posts/day,
45–105 (mean 75) spreads the day over ~10.7 hours at no more than 2 posts in any hour. Drop the cap
to 5 without touching the stagger and the whole day bunches into 5 hours, so 5/day wants 80–160
(mean 120) instead — which then delivers all 5 with never more than one post per hour. Wider is not
automatically better at either cap: simulated at 5 posts/day, a 100–200 range delivers only 4.6 of
5 and 120–240 only 3.8, because the last posts fall past the 22h window edge and defer to the next
day.

**At 15 posts/day (since 2026-09-15) the stagger is 35–65.** Raising the cap to 15 while leaving
45–105 in place delivers only **10.3** posts/day in simulation — the raise would silently do almost
nothing. Simulated at tick 20, 4,000 days:

| stagger @ 15/day | delivered | mean gap | span | max posts/hour |
|---|---|---|---|---|
| 45–105 (unchanged) | 10.3 | 75 min | 11.6 h | 2 |
| 30–80 | 14.1 | 55 min | 11.9 h | 3 |
| **35–65 (now)** | **14.9** | 50 min | 11.6 h | 3 |
| 30–60 | 15.0 | 45 min | 10.5 h | 3 |
| 20–60 | 15.0 | 40 min | 9.3 h | 4 |

35–65 was picked over 30–60 for the wider spread across the day at the same hourly peak.

**Since 2026-09-17: 20 posts/day inside several "golden hour" windows, not one 8h–22h band.**
`ACTIVE_WINDOWS` (`07:00-08:30,11:00-13:00,18:00-22:30` VN time; **widened by 15 min at each edge to
`06:45-08:45,10:45-13:15,17:45-22:45` on 2026-09-29**, ~9.5 window-hours ≈ 28 tick slots) replaces
`ACTIVE_HOURS_START/END` when set; those two remain only as the fallback when it is empty.
`src/utils/activeWindows.ts` owns all window math. Three things changed with it:

- **`staggeredSchedule` counts only in-window minutes** (`addActiveMinutes`). Adding wall-clock
  minutes would park every job composed at 13h in the afternoon gap, then release them all as
  overdue the moment 18h opens — pacing would silently collapse to the tick alone.
- **"Next window" can be later today.** Outside-hours retries go to `nextWindowStart` (lunch break →
  18h the same day), but daily-cap and per-group-cap retries go to *tomorrow's* first window —
  otherwise a capped job would be retried at 18h against a cap that is still full.
- **At this volume the tick, not the stagger, is the binding constraint.** 8 window-hours × 3
  posts/hour (tick 20) ≈ 24 slots for 20 posts. Simulated over 1,500 days with listings arriving
  7h–21h, every stagger from 20–35 to 35–65 delivered 20.0/day, min gap 15, max 3/hour; 25–40 was
  kept (≈ 8h / 20). Posts land roughly 5 morning / 5 lunch / 10 evening, and the evening window is
  usually full before 21h30. **Shrinking the windows below ~7 hours total makes 20/day
  undeliverable at tick 20** — re-derive before trimming them, and note the morning window runs at
  the 3/hour ceiling (backlog from overnight arrivals), the densest posting of the day.

At a 20-minute tick the 8h–22h window holds 42 slots against a 10/day cap, so the pacing costs no
posting capacity.

**The per-group interval lives in MongoDB, not `.env`.** `checkPostingAllowed` reads
`group.post_frequency.min_interval_minutes` from each group document; `GROUP_MIN_INTERVAL_MINUTES`
is only the default `seed:groups add` writes for *new* groups (it was hard-coded 180 there until
2026-09-29, so the env var did literally nothing). Changing the rule for existing groups means an
`updateMany` on `groups` — all 26 went 180 → 120 on 2026-09-29, at the user's request, because the
180-minute rule was what kept bouncing carry-over posts across days.

**Carry-over posts go first and have their own small quota (since 2026-09-29).** A *carry-over* is a
`post_to_group` job whose `created_at` is before today's VN midnight — composed on an earlier day
but not yet published. They were never dropped from the queue, but traced on real data they were
counting against the *new* day's cap and competing with fresh posts: of the 10 jobs overdue on
09-25, several bounced on `GROUP_MIN_INTERVAL_MINUTES` for 2–3 days before going out, and with
`LISTING_MAX_AGE_DAYS=2` that is one bounce away from being expired after Gemini already paid to
compose them. Now:

- `runCycle` tries `runPostingOnce(notify, "carryover")` **first** and only then `"today"` — still
  at most one job per tick; the second call only runs when the first claimed nothing.
- The first `CARRYOVER_EXTRA_POSTS_PER_DAY` (default 5) carry-overs each day are **not** counted
  against `MAX_POSTS_PER_DAY`; beyond that they fall back to regular slots but keep priority, so
  nothing starves. A fresh post never uses a carry-over slot. The rule lives in the pure
  `facebook/dailyQuota.ts` (`slotFor`) so it is unit-tested without Mongo; counters are read only
  through `dailyQuotaUsed()`, which goes through `postsTodayCount()` for the day rollover.
- Classification is by `created_at`, not `scheduled_at`, on purpose: compose budget is counted per
  compose day, so "the day's cap is for the posts composed that day" makes the two budgets agree.
- **The extra quota must stay capped.** Daily volume, not spacing, is what got the previous
  account blocked; an unbounded exemption would let the day after a 3-day power-off post a
  backlog on top of a full day. Per-group caps and `GROUP_MIN_INTERVAL_MINUTES` still apply to
  carry-overs unchanged. In practice the tick is the real ceiling anyway: ~8 window-hours × 3
  posts/hour ≈ 24 slots/day, so 20 + 5 is slot-bound, not quota-bound.
- Zalo ingestion is deliberately **not** paused while carry-overs drain. The listener only sees
  live messages, so pausing intake would lose rooms outright; ordering at the posting step gives
  the same "old first" result without dropping anything.
- `test/unit/scheduleLogic.test.ts` locks the ordering (verified by swapping the two scopes: four
  tests fail), `test/unit/dailyQuota.test.ts` the slot rules. `check:stuck` no longer accepts "at
  today's cap" as an excuse while carry-overs are overdue and carry-over slots remain.

**A deferred job no longer burns the tick (since 2026-09-30).** `runPostingOnce` used to claim one
job and stop, so when that job hit `checkPostingAllowed`'s per-group interval it was rescheduled and
the whole 20-minute slot went unused — on the evening of 09-29, 2 of 15 slots were lost that way while
overdue posts for *other* groups sat postable in the queue. `processJob` now returns `attempted`
(touched Facebook: opened the page, checked the session, posted — success *or* failure) or
`deferred` (stopped before any browser work), and `runPostingOnce` keeps claiming the next due job
until one is `attempted`, capped at `MAX_JOBS_CHECKED_PER_TICK` (6). The one-post-per-tick
invariant is intact: a deferred job never reaches Playwright, and a *failed* attempt still ends the
tick — retrying a different post right after a failure is exactly the burst the tick exists to
prevent. Overdue jobs of the current day need no separate priority tier: the queue already claims by
oldest `scheduled_at`, so they come right after carry-overs and ahead of anything not yet due, and
they count against `MAX_POSTS_PER_DAY` like any other same-day post. `runCycle` reports
all-deferred as `skipped` (INFO), not `idle`. `test/unit/postingOnce.test.ts` locks the loop
(verified by restoring the old stop-after-one behaviour: two tests fail).

**The daily counter must only ever be read through `postsTodayCount()` — reading
`app_state.daily_counters.total_posts_today` directly deadlocks the scheduler permanently.**
The counter is rolled over to a new VN business day in exactly one place: `postsTodayCount()` in
`rateLimiter.ts` (formerly the private `resetDailyCountersIfNeeded`), which is called from
`checkPostingAllowed()` — i.e. *inside* `runPostingOnce`. `runCycle`'s daily-limit gate used to read
the raw document and `return` before ever reaching that call, so the gate sat **in front of the only
code that could reset the number blocking it**. The moment the account posted its 10th post of a
day, `daily_counters` froze at `{date: <that day>, total_posts_today: 10}` and every subsequent tick
— forever, across restarts — returned "đã đủ bài hôm nay" without calling `runPostingOnce`.

Observed 2026-09-06: last successful post 2026-09-04 14:40, then 22 `post_to_group` jobs piled up
`pending` (the oldest overdue by two days), `daily_metrics` recorded `compose_count: 10` but no
`posting_count` at all for 09-05 and 09-06, and the circuit breaker was **not** tripped. The
pipeline looked healthy end to end right up to the posting step — Zalo ingested, Gemini extracted
and composed, Telegram announced each extraction — which is why it read as "scheduled but never
posted" rather than as an outage.

Three things made two days of total silence possible, and all three are now closed:
- `cronRunner` logged every non-`posted` outcome at **`debug`** while `LOG_LEVEL` defaults to
  `info`. A stopped scheduler produced literally zero log lines. `skipped` now logs at INFO with its
  reason — a *decision to stop posting* is not debug-level detail, and 40 identical
  "Đã đủ 10/10 bài hôm nay" lines on a day with no posts is unmistakable. `idle` stays at debug.
- `/status` read the same raw field, so it reported `Đã đăng hôm nay: 10/10` two days running,
  making a dead scheduler look exactly like a day that had legitimately used its quota. It now reads
  through `postsTodayCount()`.
- `npm run check:stuck` counted the overdue jobs but printed one fixed line calling them
  "bình thường nếu ngoài khung giờ đăng hoặc đã đủ hạn mức ngày" and exited 0. It now **eliminates**
  each legitimate excuse in turn (breaker tripped / outside active hours / genuinely at today's cap,
  the last computed against today's date key) and, when none applies, reports a real problem. The
  main soak-test tool must not explain away the one symptom it exists to catch.

`test/unit/scheduleLogic.test.ts` mocks `postsTodayCount` separately from the `app_state` document
and its `stateWith()` helper now always returns a **stale** `daily_counters` (an old date, at the
cap). Any future version that reads the raw field fails three tests instead of shipping silently —
verified by reverting the fix. The old helper omitted `date` entirely and fed the count through the
document, which is precisely why it never caught this.

`test/unit/scheduleLogic.test.ts` mocks `db/collections.js`, `facebook/rateLimiter.js`,
`jobs/jobQueue.js`, and `jobs/postingWorker.js` via `vi.mock` to test `runCycle`'s three skip
branches (circuit breaker tripped, outside active hours, daily limit reached) plus the
requeue-then-claim-one-job happy path, without touching real Atlas. Keep this mocked — the whole
point of `runCycle` being a thin decision function is that its branches are cheap to verify in
isolation; don't rewrite it to hit real Mongo just to "test more realistically".

### Telegram is the control plane, and chat-ID matching is the only authorization

`registerReviewCommands()` must run **before** `startTelegramBot()` — the bot binds handlers from the
command map at start time, so anything registered later is silently ignored. `sendNotification`
never throws: a Telegram outage must not break posting or Zalo ingestion.

Every command and callback checks `isAuthorized(ctx.chatId)` against `TELEGRAM_CHAT_ID`. The token
lives in `.env`, but if it ever leaks, that chat-ID check is the *only* thing stopping a stranger
from running `/resume` on a tripped breaker.

Note the package: `node-telegram-bot-api` v2 is a full rewrite with a Telegraf-style middleware API
(`bot.command(name, ctx => …)`, `ctx.match`, `ctx.reply`) and ships its own types — the old
`@types/node-telegram-bot-api` package is wrong for it and was removed.

Both directions must tolerate flaky networking, and for a while only one did. Polling survives
transient failures on its own: `node-telegram-bot-api`'s `longPoll` retries indefinitely on
`NetworkError`/`TimeoutError`/429/5xx **without advancing the offset**, so a flaky connection
(api.telegram.org is intermittently throttled by Vietnamese ISPs) logs a warning and recovers with
no message loss. **Sending had no retry at all** until 2026-08-21 — `sendNotification` caught the
error, logged it, and dropped the message. A single connect timeout silently lost a
`notifyNeedsReview`, leaving a listing waiting for a human who was never told. It now retries up to
`SEND_MAX_ATTEMPTS` with backoff, gated on the library's own `isTransientError` so it matches the
polling loop's criteria exactly and doesn't waste attempts on real errors (bad chat_id, message too
long). Non-transient errors (401 from a revoked token, etc.) do the
opposite: the generator throws, the loop dies permanently, and it cannot announce that over the very
channel that just died. Hence `isPollingAlive()` — surfaced in `/health` as `telegram.polling` and
checked by `npm run check:stuck` via that endpoint, the only two places where a dead control plane
becomes visible.

Notifications carry a **room label** (`listingLabel` in `notifyEvents.ts`), not just a group name:
one room is posted to several groups and several rooms interleave through the day, so "đã đăng lên
nhóm X" alone cannot tell you *which* room went up. The label always ends with the 6-char id
because every control command (`/retry`, `/edit`, `/reject`) takes that id — a notification without
it forces the user through `/status` to find it again.

`notifyExtracted` fires **only for listings that reach `ready`**. Zalo group traffic is mostly
chatter, commission banners and recruiting posts that end up `ignored`; announcing all of them
turns the control channel into noise and trains the user to ignore the messages that matter.
`needs_review` listings already get their own notification with inline buttons, so they are not
announced twice.

`/resume` is the only *Telegram* way to clear the Facebook circuit breaker, and nothing clears it
automatically. `npm run resume` is the CLI fallback, and it exists to break a specific deadlock:
breaker tripped **and** Telegram unreachable leaves the agent permanently stopped with no recovery
path short of hand-editing MongoDB. It keeps the design intent intact — still a deliberate human
action, still no auto-clearing — and `--status` reads breaker state without changing anything.

### Customer message alerts: Zalo 1-1 and the Messenger inbox, read-only

Added 2026-10-04 because customers *were* replying and nobody saw it. The first read of the posting
account's Messenger found **15 conversations, all in "Tin nhắn đang chờ"** (message requests — Facebook
sends no notification for these), 8 of them customers asking about rooms within the previous two
weeks. That contradicts the earlier "≈250 posts, zero contacts" reading: the contacts existed, they
were landing in a folder nobody opened, on an account nobody had on their phone.

**Zalo** (`src/zalo/directMessageAlert.ts`): `MessageListener.handleMessage` now sends every
`ThreadType.User` message to `DirectMessageAlert` and returns — a 1-1 message is a customer, never a
listing, and never reaches the batcher (with `ZALO_ALLOWED_THREAD_IDS` empty it used to be batched
as a listing). Friends are loaded with `api.getAllFriends()` on each (re)connect and every 6 h, so the
alert can say **NGƯỜI LẠ** — Zalo files strangers under "Tin nhắn từ người lạ", which is the part
that gets missed. `SenderCooldown` sends the *first* message of a burst immediately and folds the rest
for `ZALO_DM_ALERT_COOLDOWN_MINUTES`; customers type in several short lines and one alert per line
trains the user to ignore the channel. It only reads and notifies — auto-replying from a personal
account over an unofficial API is the fastest way to get the number banned.

**Messenger** (`src/facebook/inboxWatcher.ts` + pure `inboxParser.ts`): on `FB_INBOX_CHECK_CRON`
(default every 15 min, 6h–23h59, 3 min jitter, empty = off) it opens a **second tab** in the posting
browser, reads `/messages/` and `/messages/requests/`, closes the tab, and diffs against
`fb_inbox_threads` in MongoDB. Things that are easy to break:

- **`withBrowserLock` (fbBrowser.ts) serialises every browser user.** `runPostingOnce` holds it for
  the whole `processJob`; the inbox check holds it for its whole visit. Without it the inbox check
  could navigate while Playwright is typing a post. Any future browser task must take the same lock.
- **Checkpoint detection runs only when no conversation rows could be read.** `detectCheckpoint`'s
  text signals scan the top of the page, and on Messenger that includes message previews — a common
  phishing message ("trang của bạn vi phạm tiêu chuẩn cộng đồng") would otherwise trip the breaker and
  stop all posting. Rows readable ⇒ session alive and page not blocked. A real block (URL
  `/checkpoint/`, `/login/`, or text with no list) still trips the breaker, same as posting.
- **Skipped entirely while the Facebook breaker is tripped** — extra page loads on a suspected
  account make things worse.
- **Messages are end-to-end encrypted, so content is unreadable** ("Không khôi phục được tin nhắn" —
  the agent's browser has no E2EE restore PIN). New activity is therefore detected two independent
  ways: preview text changed, or the last-activity estimate from the relative label moved forward.
  Only minute-precision labels (< 60 min) are trusted for that; "10 giờ" is ±1 h and would false-alarm.
  The 15-minute schedule guarantees a new message is seen while still in minute range. All E2EE
  placeholders normalise to one value so switching between them isn't "new".
- **First run (empty collection) is a baseline**: it stores everything and sends ONE summary of
  conversations whose last message isn't ours, newest first, instead of N "new message" alerts.
  Deleting `fb_inbox_threads` re-runs it.
- Three consecutive unreadable reads (no rows, no checkpoint) send one Telegram warning: an empty
  inbox and a changed UI look identical from one read.

`test/unit/inboxParser.test.ts` uses the real `innerText` strings from the 2026-10-04 probe, and
checks both directions: must alert on a new E2EE message (unchanged preview), must not re-alert as the
label ages.

### The funnel is capped at intake, not at the end

The watched Zalo groups produce 50–100 rooms a day; the account currently publishes up to 10. Narrowing
that gap late — extracting everything and then dropping the surplus at compose time — means paying
Gemini to parse rooms that will never be published. `MAX_LISTINGS_PER_THREAD_PER_DAY` therefore
caps intake **per Zalo group per day inside `messageListener.persistBatch`**, before the DB write,
before the image download, before the extract job exists. Over-quota messages cost nothing at all.

That log line is **INFO, not WARN**, and it is the one deliberate exception to the "anything that
discards listing data logs at WARN" rule in the batching section: this is configured throttling,
not a defect. It still logs, because the daily skip count is what tells you whether the cap is set
sensibly.

**The cap is per group, and the groups are not interchangeable.** `LISTINGS_PER_THREAD_OVERRIDES`
(`threadId:n,threadId:n`) sets a cap for named threads; `MAX_LISTINGS_PER_THREAD_PER_DAY` is only
the fallback for threads not listed. One flat number is wasteful at both ends, because the quota is
metered per group and an unused slot is **not** picked up by another group: the busy thread loses
most of its good rooms while the quiet one never spends its allocation. Measured over the logs, the
three watched threads produced 35 / 11 / 8 listings — a 4× spread.

**Current setup (2026-09-17): all three threads are watched again — Diamond Homes 3 at 10,
Dat Tphomes and Pham Dinh Dat at 5 each, 20 listings/day** (Diamond Homes 3 alone at 10 from
2026-08-27 and 15 from 2026-09-15). Turning a thread off belongs in `ZALO_ALLOWED_THREAD_IDS`, not in an
override of `:0` — the allowlist drops the message in `isAllowed` before batching or parsing costs
anything, whereas a `:0` cap still builds the batch and then logs one INFO line per discarded batch.
All thread IDs are named in a `.env` comment so toggling one is a single edit.

**`MAX_LISTINGS_PER_THREAD_PER_DAY` stays strictly below the smallest real cap (3 against 5).** It is the
fallback for any thread *not* named in the overrides, so a thread re-enabled without also being
given an override lands on 3 — one newly enabled thread can never quietly eat the whole
day's budget by itself. **Re-derive it whenever `MAX_POSTS_PER_DAY` moves**: at a cap of 5 this
fallback had to drop to 2, because a fallback left at 5 would have equalled the entire day's budget
and silently voided the safeguard.

The chain is meant to be read as one thing — change one number and re-derive the others:

```
Σ per-thread caps                          = listings in       (10+5+5 = 20)
MAX_POSTS_PER_DAY / MAX_GROUPS_PER_LISTING = listings composed (20/1   = 20)
listings composed × MAX_GROUPS_PER_LISTING = posts out         (20 × 1 = 20)
```

Intake and posting capacity now balance exactly. Roughly 24% of intake still ends as
`ignored`/`needs_review`, so posts out lands nearer 11–12 than 15 — raising a per-thread cap, not
`MAX_POSTS_PER_DAY`, is what actually fills the posting quota.

**40 active groups since 2026-09-29** (26 hand-added + 14 picked from the ~72 groups the posting
account had already joined, chosen by listings-per-group gap: Cầu Giấy 9.7 → 2.6, Thanh Trì 0 → 2,
Hà Đông 6 → 1; two Triều Khúc/Tân Triều groups carry a hand-declared `Thanh Trì` area so rooms there
stop failing closed). Only add groups the account is already a member of — posting into a
non-member group fails, and auto-joining many groups is itself a spam signal.

Group capacity is not the binding constraint and was checked before raising the number: 28 active
groups × 5 posts/day configured = 140/day, and the tightest district the watched thread produces
(Cầu Giấy, 3 groups) still allows 15/day against the 3 listings it actually sends there (checked
at the 10/day cap; at 15/day that share grows to ~4–5, still inside 15). The active
window (8h–22h) with a 180-minute per-group interval capped any single group at 5 posts/day, which is
what makes the per-district figure worth re-deriving whenever groups are added or removed.

`src/index.ts` prints the **resolved** cap for every watched thread at startup. That line exists
because the overrides live in a `.env` string: one mistyped character makes a thread fall silently
back to the default, and without that log the only way to notice is to count the day's listings
after the fact.

### Stale listings expire — freshness is a correctness property here

`maintenance/listingExpiry.ts` flips `ready`/`queued`/`needs_review` listings older than
`LISTING_MAX_AGE_DAYS` (default 2) to the `expired` status and cancels their `pending` jobs.
A room advertised three days ago is usually already rented, so posting it burns one of the day's
10 slots *and* costs credibility with readers. It also bounds the queue: `post_jobs` has no TTL
on `pending` (only on `finished_at`), so without expiry a permanent intake surplus grows the
collection until it hits Atlas M0's 512MB.

`expired` counts as terminal in `imageCleanup`, and the expiry cron runs at 3:00 — fifteen minutes
*before* the image sweep — so a listing that expires tonight has its disk reclaimed in the same
maintenance window rather than a day later.

Two selection rules exist for the same reason:
- **`compose_post` claims newest-first** (`ClaimOrder` in `jobQueue.ts`). FIFO over a backlog means
  always composing the *oldest*, i.e. the most likely already-rented, room. Deferred jobs keep
  their original `created_at`, so they naturally sort behind fresh arrivals. `post_to_group` stays
  oldest-first — its `scheduled_at` spacing from `staggeredSchedule` is deliberate.
- **`pickLeastRecentlyUsed` counts picks within the batch**, not just `last_posted_at`. That field
  only changes once a post actually goes live, so during one compose batch it is constant: without
  the in-batch counter every listing in the same district picks the *same* group, piling the whole
  day into one group while the other 28 sit idle. At `MAX_GROUPS_PER_LISTING=1` that failure is
  total rather than partial.

### Posting capacity is the real budget, and it drives everything upstream

The bottleneck is **not** Gemini credits — it is how many Facebook posts a day the account can
safely make. Three settings are derived from one another and must be reasoned about together:

```
MAX_POSTS_PER_DAY / MAX_GROUPS_PER_LISTING = listings composed per day
        20        /          1             =       20
```

**Keep `MAX_GROUPS_PER_LISTING <= POST_VARIATION_COUNT`.** `assignVariations` hands out variations
round-robin (`shuffled[index % length]`), so any group beyond the variation count receives another
group's post *verbatim* — the cross-group duplicate that the whole multi-variation design exists to
avoid, and precisely what Facebook's spam detection looks for. At 3 groups and 3 variations every
post is distinct; at 5 groups and 3 variations two groups get recycled text.

`composerWorker.dailyComposeBudget()` enforces that division. Composing more listings than the
day's posting capacity can absorb is paying Gemini for text that will never be published — and
because `post_jobs` has **no TTL on `pending`** (only on `finished_at`), the unpublished jobs also
pile up forever until they hit Atlas M0's 512MB cap. Measured before this limit existed: 30
listings/day × ~8 matching groups produced ~240 post jobs/day against 3 actual posts.

Over-budget jobs are **deferred, not failed**: `deferJob` puts them back to `pending` at tomorrow's
active-window start and **decrements `attempts`** to undo the claim. Without that decrement a
listing deferred three days running would exhaust `max_attempts` and be marked `failed` without
ever having been processed once.

`MAX_GROUPS_PER_LISTING` also caps fan-out per listing, chosen from the matched set by
**least-recently-posted** (`pickLeastRecentlyUsed`). Taking the first N of the list instead would
hammer the same few groups daily while the rest never get used — both wasted reach and exactly the
behavior that gets an account reported by those groups.

**`MAX_IMAGES_PER_EXTRACTION=0` is a deliberate cost decision, not a bug.** Images were ~80% of
extraction input tokens (~1,100 tokens per 1024px image) while the room's actual data is in the
text; images are still downloaded and still uploaded to Facebook, they are just not sent to Gemini.

Two sharp edges came with switching it off, both worth keeping in mind before changing this code:

- `imagesPerListing()` short-circuits the zero case **first**. Its `Math.max(1, …)` floor used to
  turn `min(0, share)` back into 1, so the setting silently still sent one image per listing and
  the entire saving evaporated with nothing in the logs to show it.
- `buildListingSection()` branches on whether images were *actually attached*, not on whether the
  listing has images in MongoDB. A listing with no text used to be told "chỉ có ảnh, hãy trích
  xuất từ ảnh" — which, with images off, instructs the model to read attachments that were never
  sent and invites exactly the fabrication the system instruction forbids. That case now states
  plainly that there is nothing to extract and asks for `is_listing=false`.

`test/unit/llmBatch.test.ts` covers the first edge against the *real* `imagePreparer` (not the
mocked one the rest of that file uses), because the bug lived inside the module that would
otherwise be mocked away.

### Groups are matched to a listing's district, and no match means no post

`src/facebook/areaMatcher.ts` filters the eligible-group list per listing so a Hoàng Mai room
never lands in a Cầu Giấy group. Wrong-area posts are useless to readers and are the fastest way
to get reported and kicked out of a group — and a lost group cannot be recovered.

A group's coverage comes from `group.areas` (hand-declared, always wins) or, when that is empty,
from parsing `group.name`. The override exists because a Facebook group name is free text the
owner can change at any time; `npm run seed:groups -- areas <id> "Cầu Giấy,Nam Từ Liêm"` fixes a
bad guess without touching code, and `-- areas <id> --auto` reverts to name parsing.

**The alias table matters as much as the district list.** Real group names and real addresses use
neighborhood names far more than district names — `"Số 11/49/139 Tam Trinh"` carries no district
at all, and Gemini often leaves `address.district` null for exactly those. `districtsOfListing`
therefore scans `district`, `ward` *and* `raw`, and `DISTRICT_ALIASES` maps neighborhoods
(`tam trinh`, `chinh kinh`, `my dinh`, `nga tu so`…) back to their district. A missing alias shows
up as a listing that silently never posts.

Both "unknown" cases **fail closed**, which is the whole point:
- Listing whose district can't be determined → no post; stays `ready` with the reason recorded.
- Group whose area can't be determined → excluded, and its name is logged at WARN naming the
  `seed:groups -- areas` command, because such a group would otherwise never receive anything.

Area filtering runs in `composerWorker` **before** the Gemini call, and listings with no matching
group are dropped from the batch at that point — composing a post that provably cannot be
published anywhere would throw away a quota request. Because each listing now has its own target
list, the batch asks Gemini for `max(targets.length)` variations and each listing uses the prefix
it needs.

### Facebook automation is the highest-risk surface — fail closed, never retry blind

`src/facebook/checkpointDetector.ts` runs after **every** meaningful action in `fbPoster.ts` (page
load, opening the composer, typing, uploading, submitting). On detection the worker screenshots to
`FB_SCREENSHOT_DIR`, writes `post_history.status = "checkpoint_blocked"`, marks the job failed with
**no retry**, and trips `app_state.circuit_breaker`, which `runPostingOnce` checks before claiming
anything. The breaker never self-clears: continuing to act while Facebook is already suspicious is
what converts a checkpoint into a ban. URL signals (`/checkpoint/`, `/login/`) are more reliable
than DOM text; text signals are listed in both Vietnamese and English because the UI follows the
account language.

`post_history` gets `status: "attempting"` written **before** Playwright touches anything, so a
crash mid-post leaves evidence that a post may already be live. Nothing auto-retries that state —
re-posting to the same group is worse than not posting.

`src/maintenance/stalePostReaper.ts` (every 10 minutes) is what closes that loop: records left at
`attempting` for over 20 minutes flip to `status: "unknown"` and generate a Telegram message naming
the group to check by hand. `unknown` is a distinct status from `failed` on purpose — `failed` means
*definitely didn't post* (safe to retry), `unknown` means *nobody knows* (look first). Flipping the
status is also the de-duplication mechanism: the record no longer matches the `attempting` query, so
the next sweep won't re-notify. The 20-minute threshold is deliberately far longer than a real post
takes (tens of seconds) — misreporting an in-flight post as "unknown" while Playwright is still
typing would be worse than reporting it late.

`src/facebook/fbSelectors.ts` is the file that will need editing most often; Facebook's generated
class names are worthless, so selectors key off `aria-label`/`role` first, visible text second.
`findOptional` logs a warning when it falls through to a backup selector — that warning is early
warning that Facebook changed its UI, even while posting still works.

**`findOptional` waits for `state: "visible"`, and Facebook's `input[type="file"]` is never
visible.** That combination silently disabled every image upload on 2026-08-24: `fileInput` could
not be found, the code fell back to clicking the "Ảnh/video" button, and *that click opened the
real Windows file dialog* — because Playwright only intercepts a file chooser when a `filechooser`
listener is already registered. The OS dialog sat there blocking the page, nobody filled it in, and
the post went out with text only. `ATTACHED_ONLY_KEYS` in `fbSelectors.ts` now forces `attached`
instead of `visible` for such keys (declared centrally so a caller cannot forget), and
`fbPoster.attachImages` registers the `filechooser` listener — plus a short pause, so CDP has time
to enable interception — *before* clicking. **Never click an attachment button bare.**

Three follow-on rules from that incident:
- **`setInputFiles` not throwing proves nothing.** Writing files into an input Facebook isn't
  wired to succeeds as far as Playwright is concerned. `imagePreview` (`img[src^="blob:"]` first —
  language-independent) is the only real evidence, and failing it screenshots the composer.
- **Exactly one attach route runs, never both.** If the chooser route worked and the preview check
  merely lagged, also writing to the input directly would attach the same photos twice.
- **A listing with images never degrades to a text-only post.** `attachImages` returning 0 throws
  `ImageAttachError` *before* the Post button is clicked, so nothing is published and the job
  retries safely. A room ad with no photos gets almost no replies, and it would still consume one
  of the day's 10 posting slots — worse than not posting at all.
- Selectors must not assume `accept*="image"`: Facebook lists concrete extensions
  (`.tiff,.jfif,.pjp,…`), so the string "image" may be absent entirely.

`scripts/test-fb-post.ts` calls `attachImages`/`usableImagePaths`/`verifyComposedText` directly
rather than reimplementing them. It used to carry its own copy of the attach logic, which is why
`--dry-run` reported every selector working while the real path attached nothing — a dry run that
doesn't exercise the production code path is worse than no dry run, because it manufactures
confidence.

**Never insert a newline with the Enter key — Facebook's mention typeahead eats it.** While you type,
Facebook opens a suggestion listbox (`aria-label="Gợi ý lượt nhắc"`) matching the word under the
caret against your friends, and while it is open `Enter`/`Shift+Enter` *selects the highlighted
suggestion* instead of breaking the line. On 2026-08-24 a post whose first line ended in
`HOÀNG MAI` went out as `HOÀNG Mai Anh- Giá thuê…`: the district name became a tag of a stranger
named Mai Anh **and the line break vanished**. The stored `composed_text` was correct — the damage
happened entirely at the typing layer. Tagging uninvolved people is also one of the spam signals
Facebook punishes hardest, so this is an account-safety bug, not a cosmetic one.

`typeLikeHuman` therefore breaks lines with `page.keyboard.insertText("\n")`, which emits only an
`input` event and no keydown, so the typeahead has structurally nothing to intercept. Prefer that
over "check whether the popup is open, then press Enter" — the check loses the race whenever the
popup opens right after it. Measured: the newline lands correctly and an already-open popup closes
itself afterwards.

Two supporting rules:
- **The popup renders at body level, not inside `div[role="dialog"]`** (`inDialog: false` when
  probed), so any selector scoped to the dialog misses it. `SUGGESTION_POPUP_SELECTOR` is
  deliberately the broad `[role="listbox"]` and lives outside `SELECTORS`: it is a "is a popup
  open" probe, not a fallback chain to act on, and Facebook opens both a mention list and a search
  list whose `aria-label`s follow the UI language. `dismissSuggestionPopup` presses Escape only when
  one is actually visible — measured safe: it closes the popup, leaves the composer dialog open and
  the typed text untouched. It runs at the end of `typeLikeHuman` because a click meant for the
  "Ảnh/video" button can otherwise land on a suggestion floating over it.
- **`verifyComposedText` runs immediately before the Post click, not right after typing.** Image
  attachment happens in between and can itself insert a tag, so the latest possible check is the
  only one that covers both. It reads the composer's `innerText` back and compares it to the
  approved text through `normalizeForCompare`, which ignores whitespace-only differences (the editor
  inserts zero-width characters, and `innerText` always appends a trailing blank line) while still
  catching any changed character. A mismatch screenshots the composer and throws
  `ComposedTextMismatchError` before anything is published, so the job retries safely.
  `test/unit/composedText.test.ts` locks both directions using the real strings from the incident:
  it must catch the tag, the lost newline and an altered phone number, and must not fire on editor
  whitespace noise.

**"Đã đăng" and "đang chờ duyệt" are different outcomes and must never be reported as one.**
Many groups have post moderation on, so clicking Post puts the ad in an admin queue instead of on
the wall. The worker used to report every non-throwing post as `✅ Đã đăng`, which is a false
report: the user opens the group, sees nothing, and has no idea the post is sitting in a queue.
`PostOutcome.pendingApproval` now splits them — `post_history.status` gets a distinct
`pending_approval`, `daily_metrics` counts `posts_pending_approval` separately from `posts_success`
(gluing them together makes the daily stats look better than reality), and the Telegram message says
`⏳ Đã gửi … bài ĐANG CHỜ quản trị viên duyệt, chưa hiển thị trên nhóm` versus
`✅ Đã đăng … Bài đã hiển thị trên nhóm`.

**Pending approval deliberately takes the success path in every other respect.** It calls
`completeJob`, `recordSuccessfulPost` and `updateListingProgress` exactly like a live post, and it
must keep doing so: the post *did* go through, it consumed a real posting slot against the account
and the group, and re-posting would only add a duplicate to the same moderation queue. Treating it
as a failure that retries is the one genuinely harmful way to get this wrong.

**The detection subtracts a baseline, and that is the whole trick.** A moderated group almost always
states the rule in its own description or pinned rules ("bài viết phải được quản trị viên phê
duyệt"), and that text sits on the page *before* anything is posted. Scanning the page for approval
wording after posting would therefore flag **every** post into such a group, including ones that go
live. `postToGroup` reads the page text once right after the group page loads — before the composer
is even opened — and `freshApprovalPhrases()` counts only wording that is absent from that baseline
and present afterwards. The phrase list deliberately targets *post-state* wording ("đang chờ phê
duyệt", "sẽ hiển thị sau khi") rather than *rule* wording ("phải được phê duyệt"), so the two
mechanisms guard the same failure independently. `test/unit/pendingApproval.test.ts` locks the
baseline behaviour, including the case where the rules mention approval *and* a real notice appears.

**The phrase list is inferred from Facebook's usual wording, not observed from a real moderated
post — treat it as a starting point.** It fails in the safe direction: a missed phrase reports
`✅ Đã đăng` exactly as before this feature existed, so nothing regresses. When detection *does*
fire it screenshots to `FB_SCREENSHOT_DIR` as `…-cho-duyet.png` and logs the matched phrases at
INFO, which is what makes a true positive verifiable and a false positive traceable. If a post is
reported as live but was actually held, the whole fix is adding one string to
`PENDING_APPROVAL_PHRASES` in `fbPoster.ts`.

Note that `readVisibleText` reads the **whole** body innerText, unlike `detectCheckpoint` which
slices the first 4,000 characters. That difference is intentional: block warnings always render at
the top of the page, but a "chờ duyệt" confirmation is a dialog or toast that can sit anywhere in
the DOM, so slicing would drop exactly the text being looked for.

Session handling never types credentials (`fbBrowser.checkSession` only *reads* login state). A dead
session trips the breaker and waits for `npm run login:facebook`. `launchPersistentContext` with
`channel: "chrome"` and `timezoneId: Asia/Ho_Chi_Minh` keeps the fingerprint stable and consistent
with a Vietnamese account — a VPS running UTC with a vi-VN locale is a contradiction worth avoiding.

Rate-limit defaults are deliberately conservative (`MAX_POSTS_PER_DAY=3`, active hours 8h–22h with
jitter) because the account in use is new and therefore has near-zero trust. `isWithinActiveHours`
takes optional start/end hours purely so tests can assert boundaries without depending on `.env` or
wall-clock time.

### Timezone: everything business-relevant is Asia/Ho_Chi_Minh, never UTC

`src/utils/time.ts` (`businessDateKey`, `businessHour`) is the only sanctioned way to compute a
date key or hour-of-day for anything user-facing (daily counters, `daily_metrics._id`, log
timestamps). Do not use `Date.toISOString().slice(0, 10)` for date keys — the production VPS runs
UTC, and that would roll counters over at 7am Vietnam time instead of midnight. `src/utils/logger.ts`
also formats its own timestamp through this timezone rather than pino's default.

### Reconnection has a circuit breaker, not infinite retry

`src/zalo/reconnectManager.ts` treats zca-js's `CloseReason` codes differently: ordinary
disconnects retry with exponential backoff (capped at `ZALO_RECONNECT_MAX_ATTEMPTS`), but
`DuplicateConnection`/`KickConnection` (opening Zalo Web elsewhere kicks the bot — zca-js only
allows one active web session per account) trip `app_state.zalo_circuit_breaker` immediately and
stop retrying — retrying against a genuinely dead session just generates more suspicious traffic
against an unofficial API. Tripping the Zalo breaker only stops *ingestion*; it does not pause
extraction or (eventually) posting for listings already in MongoDB.

### Log rotation happens inside the app, not via VPS `logrotate`

`src/utils/logger.ts` uses `pino({ transport: { targets: [...] } })` with two targets running in
parallel, not a single destination: one `pino-roll` target that is **always on** and writes
`LOG_DIR/app.<yyyy-MM-dd>.<n>.log`, rotating daily and keeping only `LOG_RETENTION_DAYS` files
before deleting older ones; one console target that's `pino-pretty` when `LOG_PRETTY=true` or raw
JSON via `pino/file` (`destination: 1`, i.e. stdout) otherwise. This was chosen over configuring
`logrotate` on the VPS specifically so log rotation behaves identically on a Windows dev machine and
a Linux VPS — no OS-level cron/config to keep in sync across environments. The custom VN-timezone
`timestamp` function still applies once at the core `pino()` level; both targets receive the same
already-timestamped JSON, one just re-renders it prettily.

### Maintenance runs on its own internal cron, separate from the posting scheduler

`src/maintenance/cronJobs.ts` (`startMaintenanceScheduler`, started from `src/index.ts`) owns four
`node-cron` tasks, all deliberately independent of the Facebook posting scheduler and its circuit
breaker — when posting is tripped the disk still fills up and stuck posts still need reporting, so
this work must keep running precisely when the posting side has stopped:

- daily 3:15am — image/screenshot cleanup (below)
- hourly — disk usage check (below)
- every 10 min — `stalePostReaper` (see "Facebook automation" section)
- Sunday 3:45am — `sessionBackup` (below)

**Image cleanup** (`src/maintenance/imageCleanup.ts`) deletes the whole per-listing image directory
for listings whose `status` is `posted`/`ignored`/`rejected` — the state machine's true terminal
states — and older than `IMAGE_RETENTION_DAYS`. It deliberately excludes `failed`/`duplicate`:
`/retry` can still recompose those and needs the original images, so cleaning them would silently
break a future retry. After deleting a directory the listing doc is updated in place
(`storage: "none"`, `local_path: null`) so MongoDB stops claiming images exist that are gone.
Orphaned screenshots are deleted by file mtime rather than by looking up `post_history`, because
the TTL has already removed the records that referenced them.

**Disk monitoring** uses `src/utils/diskUsage.ts` (`fs.statfs` — works on both Windows dev and the
Linux VPS, no extra dependency) on `process.cwd()`'s partition; over `DISK_USAGE_WARN_PERCENT` it
sends one Telegram notification per VN business day, debounced via
`app_state.disk_warning.last_notified_date` (a field added after `AppStateDoc` was first designed —
always read it through `?? null`, existing Atlas documents won't have it until first written).
Without the debounce this would page every hour for as long as the disk stays full. The same
`getDiskUsage()` feeds `healthServer.ts`'s `disk_usage_percent`, and crossing the threshold
downgrades `/health` to `"degraded"` (never `"down"` on its own — a full disk isn't yet a hard
outage the way a tripped circuit breaker is).

**Session backup** (`src/maintenance/sessionBackup.ts`) copies `ZALO_SESSION_DIR` and
`FB_BROWSER_PROFILE_DIR` into a timestamped folder under `SESSION_BACKUP_DIR`, keeping the newest
`SESSION_BACKUP_KEEP`. `SKIP_DIRECTORIES` filters out Chrome's regenerable caches, which is what
takes the real profile from ~218MB to ~4.5MB — small enough to keep several copies and to actually
copy off the VPS. What matters is `Default/Network/Cookies` (note: modern Chrome puts cookies under
`Network/`, not directly in `Default/`), `Default/Local Storage`, and `Default/Preferences`. Both
login scripts call `backupSessions()` right after a successful login, which is both when the profile
is cleanest (browser just closed, no half-written SQLite) and when it's most valuable — nobody wants
to redo a manual Facebook login. The weekly cron notifies on failure, because silently having no
backup is only discovered at the worst possible moment.

The `scripts/cleanup-images.ts` and `scripts/backup-sessions.ts` CLIs are thin wrappers over these
modules — don't duplicate logic there, extend the module.

### MongoDB retention: `post_jobs`/`post_history` are ephemeral, `daily_metrics` is not

Both `post_jobs` (via `finished_at`) and `post_history` (via `posted_at`) have TTL indexes at
`JOB_HISTORY_RETENTION_DAYS` (default 7 days) — this exists to stay under the Atlas M0 512MB cap.
`daily_metrics` has no TTL and is incremented directly (`incrementDailyMetric` in
`src/db/indexes.ts`) at the moment each event happens, specifically because it needs to survive
after the detailed records it's derived from are deleted.

### Dashboard + Windows autostart: a supervisor process, not a page inside the agent

`src/dashboard/` is a **separate process** that serves the management UI and runs the agent
(`src/index.ts`) as a forked child (`agentProcess.ts`), restarting it with exponential backoff
(5s → 5min, reset after 10 min of stable running). It is separate on purpose: the moments you need
the dashboard most — agent crashing at boot because Wi-Fi isn't up yet, a bad `.env` — are exactly
when an in-agent page would be gone. It reads MongoDB directly (reconnecting forever), reuses
`reviewFlow.ts`'s exported `approve`/`reject`/`retry`/`pause`/`resume` rather than a second copy,
and only asks the agent's `/health` for what lives in agent memory (Telegram polling state).
Autostart is a Startup-folder shortcut → `scripts/autostart/launch-hidden.vbs` → hidden
`node --import tsx src/dashboard/main.ts`: no admin rights, and it runs inside the user's session,
which Playwright needs when `FB_HEADLESS=false` (a Windows Service runs in session 0, no desktop).

Invariants that are easy to break:

- **The agent's health port is a single-instance lock.** `startHealthServer()` now rejects on
  `EADDRINUSE` and runs *first* in `main()`, before Mongo, Telegram, the stale-job sweep or Zalo. With
  the agent running in the background, typing `npm run dev` out of habit would otherwise open a second
  Zalo session — zca-js allows one, so they kick each other and trip the Zalo breaker. The
  supervisor probes that port before forking and reports `external` instead of crash-looping.
- **Stopping goes over IPC, never `child.kill()`.** On Windows `kill()` is `TerminateProcess`: no
  shutdown handler runs, Playwright is cut mid-action, the Chrome profile can corrupt. `shutdown.ts`
  listens for an IPC `"shutdown"` message when `process.send` exists; `kill` is only the fallback
  after 45s.
- **On Windows, killing the dashboard hard-kills the agent too** (measured): libuv puts children in
  a `KILL_ON_JOB_CLOSE` job object. Good — no orphan agent can ever duplicate the Zalo session — but
  it means the dashboard must stop the agent *before* exiting. That is why `npm run dashboard:stop`
  POSTs `/api/dashboard/quit` instead of `Stop-Process`, which is only its last resort. The
  `disconnect` handler in `shutdown.ts` is the equivalent safety net for Linux, where children survive.
- **The child gets the environment snapshotted *before* the dashboard loads `.env`** (`main.ts`).
  dotenv never overrides existing variables, so passing the loaded values would make the agent ignore
  `.env` edits — "edit `.env`, click Restart" would silently change nothing. The child also gets
  `LOG_PRETTY=false` (the UI parses pino JSON from stdout) and the dashboard logs to
  `LOG_DIR/dashboard/` so two long-lived processes never rotate the same pino-roll file.
- **The child's stdout/stderr must always be drained** — a hidden process has no console, and an
  unread pipe fills up and blocks the agent on its next log write.
- **Don't trust `zalo_session.connected` while the agent isn't running**: only agent startup clears
  it, so a hard-killed agent leaves it stuck at `true`. The UI shows "Agent không chạy" instead.
- Security is localhost bind + a `Host` allowlist (DNS rebinding) + a required `x-dashboard-action`
  header on every POST (a cross-origin page can't send it without a CORS preflight, which is never
  answered). Everything from Zalo is untrusted text and is escaped in `ui.html`.
- Crash notifications go straight to the Bot API, not `sendNotification`: that needs a started bot,
  and starting one here would run a second `getUpdates` loop against the agent's (409 Conflict).
  Only the first crash of a streak is announced.

### Deployment: pick systemd **or** pm2, never both

[deploy/](deploy/) holds a systemd unit and a pm2 ecosystem config. Running both means two processes
sharing one Zalo account, and zca-js allows only one web session — they would kick each other out in
a loop. Both configs set `TZ=Asia/Ho_Chi_Minh` explicitly (without it every business date/hour
calculation shifts by 7 hours on a UTC VPS), pin a single instance, and allow ~45s for shutdown so
`closeBrowser()` can close the Playwright profile cleanly — a corrupted profile means a manual
Facebook re-login. The pm2 config is `.cjs` because `package.json` sets `"type": "module"` and pm2
`require()`s its config; it also sends pm2's own logs to `/dev/null` since pino-roll already writes
and rotates `logs/`.

Operational procedures (checkpoint recovery, session restore, disk full, Zalo kicked) live in
[RUNBOOK.md](RUNBOOK.md) — update it alongside any change to failure handling.
