import http from "node:http";
import { APP_STATE_ID } from "../config/constants.js";
import { env } from "../config/env.js";
import { appState, dailyMetrics, listings, postJobs } from "../db/collections.js";
import { isPollingAlive, isTelegramConfigured } from "../notifier/telegramBot.js";
import { getDiskUsage } from "../utils/diskUsage.js";
import { childLogger } from "../utils/logger.js";
import { businessDateKey, formatBusinessTime } from "../utils/time.js";

const log = childLogger("health");

let server: http.Server | null = null;
const startedAt = Date.now();

interface HealthReport {
    status: "ok" | "degraded" | "down";
    zalo: { connected: boolean; last_message_at: string | null; circuit_breaker: boolean };
    facebook: { circuit_breaker: boolean; reason: string | null };
    /** Kênh điều khiển. `polling: false` = mọi lệnh Telegram ngừng hoạt động. */
    telegram: { configured: boolean; polling: boolean };
    jobs: { pending: number; processing: number; failed_today: number };
    listings: { needs_review: number; queued: number };
    today: { date: string; posts_success: number; posts_failed: number; listings_received: number };
    disk_usage_percent: number;
    uptime_seconds: number;
    checked_at: string;
}

async function buildReport(): Promise<HealthReport> {
    const state = await appState().findOne({ _id: APP_STATE_ID });
    const today = businessDateKey();
    const metrics = await dailyMetrics().findOne({ _id: today });

    const [pending, processing, failedToday, needsReview, queued] = await Promise.all([
        postJobs().countDocuments({ status: "pending" }),
        postJobs().countDocuments({ status: "processing" }),
        postJobs().countDocuments({ status: "failed", finished_at: { $gte: new Date(Date.now() - 86_400_000) } }),
        listings().countDocuments({ status: "needs_review" }),
        listings().countDocuments({ status: "queued" }),
    ]);

    const fbTripped = state?.circuit_breaker.tripped ?? false;
    const zaloTripped = state?.zalo_circuit_breaker.tripped ?? false;
    const zaloConnected = state?.zalo_session.connected ?? false;
    const diskUsage = await getDiskUsage(process.cwd());
    const telegramConfigured = isTelegramConfigured();
    // Bot chết là mất kênh điều khiển, và KHÔNG thể tự báo qua Telegram được — endpoint này
    // là một trong hai nơi duy nhất phát hiện ra (nơi kia là npm run check:stuck).
    const telegramDead = telegramConfigured && !isPollingAlive();

    // "degraded" khi một nhánh hỏng nhưng phần còn lại vẫn chạy — ví dụ Zalo mất kết nối
    // thì việc đăng bài cho các tin đã có vẫn tiếp tục bình thường. Đĩa gần đầy cũng chỉ ở mức
    // "degraded" (chưa hỏng gì) — cronJobs.ts đã tự cảnh báo Telegram riêng cho việc này.
    let status: HealthReport["status"] = "ok";
    if (fbTripped && zaloTripped) status = "down";
    else if (
        fbTripped ||
        zaloTripped ||
        !zaloConnected ||
        telegramDead ||
        diskUsage.percentUsed >= env.DISK_USAGE_WARN_PERCENT
    )
        status = "degraded";

    return {
        status,
        zalo: {
            connected: zaloConnected,
            last_message_at: state?.zalo_session.last_message_at?.toISOString() ?? null,
            circuit_breaker: zaloTripped,
        },
        facebook: { circuit_breaker: fbTripped, reason: state?.circuit_breaker.reason ?? null },
        telegram: { configured: telegramConfigured, polling: isPollingAlive() },
        jobs: { pending, processing, failed_today: failedToday },
        listings: { needs_review: needsReview, queued },
        today: {
            date: today,
            posts_success: metrics?.posts_success ?? 0,
            posts_failed: metrics?.posts_failed ?? 0,
            listings_received: metrics?.listings_received ?? 0,
        },
        disk_usage_percent: diskUsage.percentUsed,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        checked_at: formatBusinessTime(),
    };
}

/**
 * Mở endpoint kiểm tra sức khoẻ.
 *
 * Mặc định chỉ nghe 127.0.0.1: báo cáo này để lộ toàn bộ tình trạng vận hành
 * (phiên còn sống không, bao nhiêu job đang chờ), không nên hở ra internet.
 * Xem từ xa qua SSH tunnel: ssh -L 3100:127.0.0.1:3100 user@vps
 */
export function startHealthServer(): void {
    server = http.createServer((request, response) => {
        if (!request.url?.startsWith("/health")) {
            response.writeHead(404).end();
            return;
        }

        void buildReport()
            .then((report) => {
                response.writeHead(report.status === "down" ? 503 : 200, {
                    "content-type": "application/json; charset=utf-8",
                });
                response.end(JSON.stringify(report, null, 2));
            })
            .catch((error) => {
                log.error({ err: error }, "Không dựng được báo cáo sức khoẻ");
                response.writeHead(500, { "content-type": "application/json" });
                response.end(JSON.stringify({ status: "down", error: String(error) }));
            });
    });

    server.listen(env.HEALTH_CHECK_PORT, env.HEALTH_CHECK_BIND, () => {
        log.info(
            { url: `http://${env.HEALTH_CHECK_BIND}:${env.HEALTH_CHECK_PORT}/health` },
            "Endpoint kiểm tra sức khoẻ đã bật",
        );
    });

    server.on("error", (error) => {
        log.error({ err: error }, "Máy chủ health lỗi");
    });
}

export async function stopHealthServer(): Promise<void> {
    if (!server) return;

    await new Promise<void>((resolve) => {
        server?.close(() => resolve());
    });

    server = null;
    log.info("Đã dừng endpoint kiểm tra sức khoẻ");
}
