import type { ObjectId } from "mongodb";
import { APP_STATE_ID } from "../config/constants.js";
import { env } from "../config/env.js";
import { appState, dailyMetrics, groups, listings, postHistory, postJobs } from "../db/collections.js";
import { isCarryoverJob } from "../facebook/dailyQuota.js";
import { dailyQuotaUsed } from "../facebook/rateLimiter.js";
import { formatActiveWindows, isWithinWindows } from "../utils/activeWindows.js";
import { getDiskUsage } from "../utils/diskUsage.js";
import { businessDateKey, businessDayStart } from "../utils/time.js";

/**
 * Toàn bộ số liệu dashboard hiển thị, đọc thẳng từ MongoDB — KHÔNG hỏi qua agent, để agent chết thì
 * dashboard vẫn cho thấy hàng đợi, cầu dao, bài đã đăng. Riêng tình trạng bot Telegram chỉ agent
 * biết (nằm trong bộ nhớ tiến trình), nên lấy từ /health của agent khi nó còn sống.
 */

/** 6 ký tự cuối của id — đúng mã mà mọi lệnh Telegram (/approve, /retry…) nhận. */
const codeOf = (id: ObjectId | undefined): string => id?.toHexString().slice(-6) ?? "";

async function nameMaps(listingIds: ObjectId[], groupIds: ObjectId[]) {
    const [listingDocs, groupDocs] = await Promise.all([
        listings()
            .find({ _id: { $in: listingIds } }, { projection: { "parsed_data.title": 1, "parsed_data.address.raw": 1 } })
            .toArray(),
        groups()
            .find({ _id: { $in: groupIds } }, { projection: { name: 1 } })
            .toArray(),
    ]);

    const listingLabel = new Map(
        listingDocs.map((doc) => [
            doc._id.toHexString(),
            doc.parsed_data?.title ?? doc.parsed_data?.address?.raw ?? "(chưa có tiêu đề)",
        ]),
    );
    const groupName = new Map(groupDocs.map((doc) => [doc._id.toHexString(), doc.name]));
    return { listingLabel, groupName };
}

async function agentHealth(): Promise<Record<string, unknown> | null> {
    try {
        const response = await fetch(`http://${env.HEALTH_CHECK_BIND}:${env.HEALTH_CHECK_PORT}/health`, {
            signal: AbortSignal.timeout(3_000),
        });
        return (await response.json()) as Record<string, unknown>;
    } catch {
        return null;
    }
}

export async function buildOverview() {
    const today = businessDateKey();
    const now = new Date();
    const dayStart = businessDayStart(now);

    const [state, quota, carryoverPending, metrics, statusCounts, groupCounts, review, upcoming, recent, health, disk] =
        await Promise.all([
            appState().findOne({ _id: APP_STATE_ID }),
            // Đọc qua dailyQuotaUsed() (đi qua postsTodayCount), KHÔNG đọc daily_counters thô — số thô có
            // thể là của ngày hôm kia và từng làm một bộ điều phối đã chết trông y như ngày dùng hết
            // hạn mức (CLAUDE.md).
            dailyQuotaUsed(),
            postJobs().countDocuments({
                type: "post_to_group",
                status: { $in: ["pending", "claimed", "processing"] },
                created_at: { $lt: dayStart },
            }),
            dailyMetrics().find().sort({ _id: -1 }).limit(7).toArray(),
            listings()
                .aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }])
                .toArray(),
            groups()
                .aggregate<{ _id: boolean; n: number }>([{ $group: { _id: "$active", n: { $sum: 1 } } }])
                .toArray(),
            listings().find({ status: "needs_review" }).sort({ created_at: -1 }).limit(20).toArray(),
            postJobs()
                .find({ type: "post_to_group", status: { $in: ["pending", "claimed", "processing"] } })
                .sort({ scheduled_at: 1 })
                .limit(15)
                .toArray(),
            postHistory().find().sort({ posted_at: -1 }).limit(15).toArray(),
            agentHealth(),
            getDiskUsage(process.cwd()),
        ]);

    const { listingLabel, groupName } = await nameMaps(
        [...upcoming.map((job) => job.payload.listing_id), ...recent.map((post) => post.listing_id)],
        [
            ...upcoming.map((job) => job.payload.group_id).filter((id): id is ObjectId => id !== null),
            ...recent.map((post) => post.group_id),
        ],
    );

    const todayMetrics = metrics.find((day) => day._id === today);
    const telegram = health?.telegram as { configured?: boolean; polling?: boolean } | undefined;

    return {
        checked_at: now.toISOString(),
        breakers: {
            facebook: {
                tripped: state?.circuit_breaker.tripped ?? false,
                reason: state?.circuit_breaker.reason ?? null,
                tripped_at: state?.circuit_breaker.tripped_at ?? null,
            },
            zalo: {
                tripped: state?.zalo_circuit_breaker.tripped ?? false,
                reason: state?.zalo_circuit_breaker.reason ?? null,
            },
        },
        zalo: {
            connected: state?.zalo_session.connected ?? false,
            last_message_at: state?.zalo_session.last_message_at ?? null,
            last_error: state?.zalo_session.last_error ?? null,
        },
        telegram: telegram ? { configured: telegram.configured ?? false, polling: telegram.polling ?? false } : null,
        posting: {
            posts_today: quota.regular,
            max_posts_per_day: env.MAX_POSTS_PER_DAY,
            carryover_today: quota.carryover,
            carryover_extra_per_day: env.CARRYOVER_EXTRA_POSTS_PER_DAY,
            /** Bài tồn từ ngày trước còn chờ đăng — được ưu tiên trước bài hôm nay. */
            carryover_pending: carryoverPending,
            windows: formatActiveWindows(env.ACTIVE_WINDOWS),
            in_window_now: isWithinWindows(now, env.ACTIVE_WINDOWS),
        },
        today: {
            date: today,
            listings_received: todayMetrics?.listings_received ?? 0,
            listings_ignored: todayMetrics?.listings_ignored ?? 0,
            compose_count: todayMetrics?.compose_count ?? 0,
            posts_success: todayMetrics?.posts_success ?? 0,
            posts_pending_approval: todayMetrics?.posts_pending_approval ?? 0,
            posts_failed: todayMetrics?.posts_failed ?? 0,
        },
        history: metrics
            .map((day) => ({
                date: day._id,
                received: day.listings_received ?? 0,
                ignored: day.listings_ignored ?? 0,
                composed: day.compose_count ?? 0,
                success: day.posts_success ?? 0,
                pending_approval: day.posts_pending_approval ?? 0,
                failed: day.posts_failed ?? 0,
            }))
            .reverse(),
        listing_counts: Object.fromEntries(statusCounts.map((row) => [row._id, row.n])),
        groups: {
            active: groupCounts.find((row) => row._id === true)?.n ?? 0,
            inactive: groupCounts.find((row) => row._id !== true)?.n ?? 0,
        },
        review: review.map((doc) => ({
            code: codeOf(doc._id),
            title: doc.parsed_data?.title ?? null,
            address: doc.parsed_data?.address?.raw ?? null,
            district: doc.parsed_data?.address?.district ?? null,
            price_vnd: doc.parsed_data?.price_vnd ?? null,
            confidence: doc.confidence_score,
            reason: doc.is_listing_reason,
            raw_text: doc.raw_message.text.slice(0, 600),
            images: doc.images.length,
            sender: doc.source.sender_name,
            created_at: doc.created_at,
        })),
        upcoming: upcoming.map((job) => ({
            listing_code: codeOf(job.payload.listing_id),
            listing: listingLabel.get(job.payload.listing_id.toHexString()) ?? "?",
            group: job.payload.group_id ? (groupName.get(job.payload.group_id.toHexString()) ?? "?") : "?",
            status: job.status,
            scheduled_at: job.scheduled_at,
            overdue: job.status === "pending" && job.scheduled_at.getTime() < now.getTime(),
            carryover: isCarryoverJob(job.created_at, dayStart),
            attempts: job.attempts,
            last_error: job.last_error,
        })),
        recent_posts: recent.map((post) => ({
            listing_code: codeOf(post.listing_id),
            listing: listingLabel.get(post.listing_id.toHexString()) ?? "?",
            group: groupName.get(post.group_id.toHexString()) ?? "?",
            status: post.status,
            posted_at: post.posted_at,
            url: post.fb_post_url,
            error: post.error_message,
            note: post.note ?? null,
        })),
        disk_usage_percent: disk.percentUsed,
        disk_warn_percent: env.DISK_USAGE_WARN_PERCENT,
    };
}
