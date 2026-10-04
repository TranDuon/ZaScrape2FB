import cron, { type ScheduledTask } from "node-cron";
import type { Page } from "playwright";
import { APP_STATE_ID } from "../config/constants.js";
import { env } from "../config/env.js";
import { appState, fbInboxThreads } from "../db/collections.js";
import { tripCircuitBreaker, type NotifyFn } from "../jobs/postingWorker.js";
import type { FbInboxThreadDoc } from "../models/fbInboxThread.model.js";
import { childLogger } from "../utils/logger.js";
import { captureScreenshot, detectCheckpoint } from "./checkpointDetector.js";
import { getBrowserContext, humanPause, withBrowserLock } from "./fbBrowser.js";
import {
    E2EE_PREVIEW,
    detectActivity,
    estimateLastActivity,
    formatAge,
    parseInboxRow,
    type InboxFolder,
    type InboxRow,
} from "./inboxParser.js";

const log = childLogger("fb:inbox");

const FACEBOOK_ORIGIN = "https://www.facebook.com";
const FOLDERS: Array<{ folder: InboxFolder; url: string }> = [
    { folder: "inbox", url: `${FACEBOOK_ORIGIN}/messages/` },
    // "Tin nhắn đang chờ" — tin của người lạ (chưa kết bạn) rơi vào đây và Facebook KHÔNG báo gì cả.
    // Đo ngày 2026-10-04: 8 khách nhắn hỏi phòng trong 2 tuần nằm im ở đây, không ai trả lời.
    { folder: "requests", url: `${FACEBOOK_ORIGIN}/messages/requests/` },
];

/** Danh sách đoạn chat dựng bằng JS sau khi tải trang — chờ tối đa ngần này cho dòng đầu tiên. */
const ROWS_TIMEOUT_MS = 20_000;
/** Không đọc được danh sách bao nhiêu lần liên tiếp thì báo người dùng (giao diện có thể đã đổi). */
const UNREADABLE_ALERT_AFTER = 3;
const MAX_LINES_IN_SUMMARY = 15;

let task: ScheduledTask | null = null;
let consecutiveUnreadable = 0;

type FolderRead =
    | { status: "ok"; rows: InboxRow[] }
    | { status: "blocked"; reason: string; screenshot: string | null }
    | { status: "unreadable" };

/**
 * Đọc danh sách đoạn chat của một mục.
 *
 * CHỈ dò checkpoint khi không đọc được dòng nào. Bộ dò chữ của `detectCheckpoint` quét phần đầu
 * trang, mà trên trang Messenger phần đó chứa cả nội dung xem trước của tin nhắn — một tin lừa đảo
 * kiểu "trang của bạn vi phạm tiêu chuẩn cộng đồng" (rất phổ biến) sẽ ngắt cầu dao nhầm và dừng
 * toàn bộ việc đăng bài. Đọc được danh sách nghĩa là phiên vẫn sống và trang không bị chặn.
 */
async function readFolder(page: Page, folder: InboxFolder, url: string): Promise<FolderRead> {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('a[href*="/messages/"][href*="/t/"]', { timeout: ROWS_TIMEOUT_MS }).catch(() => null);
    await humanPause(1_500, 3_500);

    const raw = await page
        .$$eval('a[href*="/messages/"][href*="/t/"]', (anchors) =>
            anchors.map((anchor) => ({ href: anchor.getAttribute("href") ?? "", text: (anchor as unknown as { innerText: string }).innerText })),
        )
        .catch(() => [] as Array<{ href: string; text: string }>);

    const rows = raw
        .map((item) => parseInboxRow(item.text, item.href, folder))
        .filter((row): row is InboxRow => row !== null);

    if (rows.length > 0 && page.url().includes("/messages")) return { status: "ok", rows };

    const checkpoint = await detectCheckpoint(page);
    if (checkpoint.detected) {
        const screenshot = await captureScreenshot(page, `checkpoint-hop-thu-${folder}`);
        return { status: "blocked", reason: `${checkpoint.kind}: ${checkpoint.evidence}`, screenshot };
    }

    // Hộp thư trống thật cũng rơi vào đây — không phân biệt được với giao diện đổi, nên chỉ báo khi
    // lặp lại nhiều lần liên tiếp.
    return { status: "unreadable" };
}

/** Một hội thoại có thể hiện ở cả hai mục; gộp lại và ưu tiên nhãn "đang chờ" (người lạ). */
function mergeRows(reads: InboxRow[][]): InboxRow[] {
    const byId = new Map<string, InboxRow>();
    for (const rows of reads) {
        for (const row of rows) {
            const existing = byId.get(row.threadId);
            if (!existing || row.folder === "requests") byId.set(row.threadId, row);
        }
    }
    return [...byId.values()];
}

function describeRow(row: InboxRow): string[] {
    const who = row.folder === "requests" ? "NGƯỜI LẠ (tin nhắn đang chờ)" : "hộp thư chính";
    const preview = row.preview === E2EE_PREVIEW ? "(mã hoá đầu cuối — mở Messenger để đọc)" : row.preview || "(trống)";
    return [`• ${row.name} — ${who} — ${formatAge(row.ageMinutes)}`, `  Nội dung: ${preview}`, `  ${FACEBOOK_ORIGIN}${row.href}`];
}

function newMessagesText(rows: InboxRow[]): string {
    const lines = [`💬 Facebook: ${rows.length} cuộc trò chuyện có tin nhắn mới (tài khoản đăng bài)`, ""];
    for (const row of rows.slice(0, MAX_LINES_IN_SUMMARY)) lines.push(...describeRow(row));
    if (rows.length > MAX_LINES_IN_SUMMARY) lines.push(`… và ${rows.length - MAX_LINES_IN_SUMMARY} cuộc khác`);
    lines.push("", 'Trả lời bằng Messenger của tài khoản đăng bài. Tin của người lạ nằm ở mục "Tin nhắn đang chờ".');
    return lines.join("\n");
}

/**
 * Lần kiểm tra đầu tiên chưa có gì để so: không báo từng hội thoại là "mới" (sẽ thành một tràng
 * thông báo cho tin cũ), nhưng gửi MỘT bản tổng hợp — chính những tin cũ chưa trả lời đó là thứ
 * người dùng đang bỏ lỡ.
 */
function baselineText(rows: InboxRow[]): string {
    // Mới nhất lên đầu: tin vài giờ trước còn cứu được, tin vài tuần trước thì nhiều khả năng đã muộn.
    const waiting = rows
        .filter((row) => !row.fromSelf)
        .sort((a, b) => (a.ageMinutes ?? Infinity) - (b.ageMinutes ?? Infinity));
    const strangers = waiting.filter((row) => row.folder === "requests").length;
    const lines = [
        "📥 Facebook: bắt đầu theo dõi hộp thư tài khoản đăng bài.",
        `Hiện có ${waiting.length} cuộc trò chuyện mà tin cuối là của người khác (${strangers} ở mục "Tin nhắn đang chờ" — người lạ):`,
        "",
    ];
    for (const row of waiting.slice(0, MAX_LINES_IN_SUMMARY)) {
        lines.push(`• ${row.name} — ${row.folder === "requests" ? "đang chờ" : "hộp thư chính"} — ${formatAge(row.ageMinutes)}`);
    }
    if (waiting.length > MAX_LINES_IN_SUMMARY) lines.push(`… và ${waiting.length - MAX_LINES_IN_SUMMARY} cuộc khác`);
    lines.push("", "Từ giờ agent sẽ báo ngay khi có tin nhắn mới.");
    return lines.join("\n");
}

export type InboxCheckResult =
    | { status: "skipped"; reason: string }
    | { status: "blocked"; reason: string }
    | { status: "unreadable" }
    | { status: "ok"; threads: number; alerted: number; baseline: boolean };

/** So với lần trước, ghi trạng thái mới, trả về các hội thoại có tin mới. */
async function diffAndStore(rows: InboxRow[], now: Date): Promise<{ alerts: InboxRow[]; baseline: boolean }> {
    const baseline = (await fbInboxThreads().countDocuments({}, { limit: 1 })) === 0;
    const known = new Map(
        (await fbInboxThreads().find({ _id: { $in: rows.map((row) => row.threadId) } }).toArray()).map((doc) => [doc._id, doc]),
    );

    const alerts: InboxRow[] = [];

    for (const row of rows) {
        const previous: FbInboxThreadDoc | undefined = known.get(row.threadId);
        const verdict = baseline ? "none" : detectActivity(row, previous ?? null, now);
        if (verdict !== "none") alerts.push(row);

        const estimate = estimateLastActivity(row, now);
        const prevActivity = previous?.last_activity_at ?? null;
        const lastActivity =
            estimate && (!prevActivity || estimate.getTime() > prevActivity.getTime()) ? estimate : prevActivity;

        await fbInboxThreads().updateOne(
            { _id: row.threadId },
            {
                $set: {
                    name: row.name,
                    folder: row.folder,
                    href: row.href,
                    preview: row.preview,
                    last_activity_at: lastActivity,
                    last_seen_at: now,
                    ...(verdict !== "none" ? { last_notified_at: now } : {}),
                },
                $setOnInsert: { first_seen_at: now, ...(verdict === "none" ? { last_notified_at: null } : {}) },
            },
            { upsert: true },
        );
    }

    return { alerts, baseline };
}

/**
 * Kiểm tra hộp thư Messenger một lần và báo Telegram nếu có tin mới.
 *
 * Mở một tab PHỤ trong chính trình duyệt đăng bài (cùng hồ sơ, cùng phiên) rồi đóng lại; tab chính
 * của việc đăng bài không bị đụng tới. Chạy dưới khoá trình duyệt nên không bao giờ trùng lúc đang
 * đăng. Chỉ ĐỌC — không mở hội thoại, không đánh dấu đã đọc, không trả lời.
 */
export async function checkInboxOnce(notify: NotifyFn): Promise<InboxCheckResult> {
    const state = await appState().findOne({ _id: APP_STATE_ID });
    if (state?.circuit_breaker.tripped) {
        // Facebook đang nghi ngờ tài khoản: mọi lượt tải trang thêm đều làm tình hình tệ hơn.
        return { status: "skipped", reason: "Cầu dao Facebook đang ngắt" };
    }

    return withBrowserLock(async () => {
        const context = await getBrowserContext();
        const page = await context.newPage();

        try {
            const reads: InboxRow[][] = [];

            for (const [index, { folder, url }] of FOLDERS.entries()) {
                if (index > 0) await humanPause();
                const result = await readFolder(page, folder, url);

                if (result.status === "blocked") {
                    await tripCircuitBreaker(
                        `Facebook chặn phiên khi kiểm tra hộp thư (${result.reason})`,
                        notify,
                        result.screenshot,
                    );
                    return { status: "blocked", reason: result.reason } as const;
                }
                if (result.status === "ok") reads.push(result.rows);
            }

            if (reads.length === 0) {
                consecutiveUnreadable += 1;
                log.warn({ consecutive: consecutiveUnreadable }, "Không đọc được danh sách đoạn chat Messenger");
                if (consecutiveUnreadable === UNREADABLE_ALERT_AFTER) {
                    await notify(
                        `⚠️ ${UNREADABLE_ALERT_AFTER} lần liên tiếp không đọc được hộp thư Messenger của tài khoản đăng bài — ` +
                            "giao diện Facebook có thể đã đổi, tin nhắn khách sẽ KHÔNG được báo cho tới khi sửa (src/facebook/inboxWatcher.ts).",
                    );
                }
                return { status: "unreadable" } as const;
            }
            consecutiveUnreadable = 0;

            const rows = mergeRows(reads);
            const { alerts, baseline } = await diffAndStore(rows, new Date());

            if (baseline) {
                await notify(baselineText(rows));
            } else if (alerts.length > 0) {
                await notify(newMessagesText(alerts));
            }

            log.info(
                { threads: rows.length, alerted: alerts.length, baseline, names: alerts.map((row) => row.name) },
                alerts.length > 0 ? "Có tin nhắn Messenger mới — đã báo Telegram" : "Đã kiểm tra hộp thư Messenger",
            );
            return { status: "ok", threads: rows.length, alerted: alerts.length, baseline } as const;
        } finally {
            await page.close().catch(() => undefined);
        }
    });
}

/** Lỗi trong một lượt không được giết lịch kiểm tra. */
async function runCheck(notify: NotifyFn): Promise<void> {
    try {
        const result = await checkInboxOnce(notify);
        if (result.status === "skipped") log.debug({ reason: result.reason }, "Bỏ qua kiểm tra hộp thư");
    } catch (error) {
        log.error({ err: error }, "Kiểm tra hộp thư Messenger thất bại");
    }
}

/**
 * Bật lịch kiểm tra hộp thư. Lịch riêng, KHÔNG gộp vào nhịp đăng bài: khách nhắn cả ngoài khung giờ
 * đăng, và nhịp đăng chỉ chạy trong các khung giờ vàng.
 *
 * Có jitter để các lượt tải trang Messenger không rơi đúng mốc phút tròn — giống người thỉnh thoảng
 * mở Messenger xem, không giống một đồng hồ.
 */
export function startInboxWatcher(notify: NotifyFn): void {
    const expression = env.FB_INBOX_CHECK_CRON.trim();
    if (!expression) {
        log.info("FB_INBOX_CHECK_CRON để trống — không theo dõi hộp thư Messenger");
        return;
    }
    if (!cron.validate(expression)) {
        throw new Error(`FB_INBOX_CHECK_CRON không hợp lệ: "${expression}"`);
    }

    task = cron.schedule(expression, () => runCheck(notify), {
        timezone: env.TZ,
        noOverlap: true,
        maxRandomDelay: 3 * 60_000,
    });

    log.info({ cron: expression, timezone: env.TZ }, "Đã bật theo dõi hộp thư Messenger");
}

export async function stopInboxWatcher(): Promise<void> {
    await task?.stop();
    task = null;
}
