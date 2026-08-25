import { env } from "../config/env.js";
import { APP_STATE_ID, SECONDS_PER_DAY } from "../config/constants.js";
import { childLogger } from "../utils/logger.js";
import { businessDateKey } from "../utils/time.js";
import { appState, dailyMetrics, groups, listings, postHistory, postJobs } from "./collections.js";

const log = childLogger("db:indexes");

export async function ensureIndexes(): Promise<void> {
    const retentionSeconds = env.JOB_HISTORY_RETENTION_DAYS * SECONDS_PER_DAY;

    await listings().createIndexes([
        { key: { status: 1, created_at: 1 }, name: "status_created" },
        {
            // Chống trùng: hai listing không được chia sẻ bất kỳ message_id nào.
            //
            // message_ids là mảng nên đây là multikey index. Bắt buộc kèm partialFilterExpression:
            // nếu không, mọi document có mảng RỖNG đều được index thành cùng giá trị null và
            // MongoDB sẽ báo duplicate key SAI cho listing thứ hai chưa kịp gán message nào.
            key: { "source.thread_id": 1, "source.message_ids": 1 },
            name: "thread_messages_unique",
            unique: true,
            partialFilterExpression: { "source.message_ids.0": { $exists: true } },
        },
        { key: { created_at: -1 }, name: "created_desc" },
    ]);

    await groups().createIndexes([{ key: { active: 1 }, name: "active" }]);

    await postJobs().createIndexes([
        { key: { status: 1, scheduled_at: 1, type: 1 }, name: "claim_lookup" },
        {
            // Chặn composer tạo job trùng, nhưng CHỈ trên job chưa kết thúc.
            // Ràng buộc toàn phần sẽ chặn luôn /retry hợp lệ sau khi job cũ đã failed.
            key: { idempotency_key: 1 },
            name: "idempotency_active_unique",
            unique: true,
            partialFilterExpression: { status: { $in: ["pending", "claimed", "processing"] } },
        },
        {
            // TTL dọn job đã kết thúc. finished_at chỉ được set khi job kết thúc,
            // nên job đang chạy (finished_at = null) không bao giờ bị xoá nhầm.
            key: { finished_at: 1 },
            name: "finished_ttl",
            expireAfterSeconds: retentionSeconds,
        },
    ]);

    await postHistory().createIndexes([
        { key: { group_id: 1, posted_at: -1 }, name: "group_recent" },
        { key: { listing_id: 1 }, name: "listing" },
        { key: { status: 1, posted_at: 1 }, name: "stale_attempting" },
        { key: { posted_at: 1 }, name: "history_ttl", expireAfterSeconds: retentionSeconds },
    ]);

    log.info({ retention_days: env.JOB_HISTORY_RETENTION_DAYS }, "Đã tạo/đồng bộ index");
}

/** Tạo document app_state singleton nếu chưa có. Chạy một lần lúc khởi động. */
export async function ensureAppState(): Promise<void> {
    const now = new Date();

    await appState().updateOne(
        { _id: APP_STATE_ID },
        {
            $setOnInsert: {
                circuit_breaker: {
                    tripped: false,
                    tripped_at: null,
                    reason: null,
                    resume_requires_manual_ack: true,
                },
                zalo_circuit_breaker: {
                    tripped: false,
                    tripped_at: null,
                    reason: null,
                    last_disconnect_at: null,
                    reconnect_attempts: 0,
                },
                daily_counters: { date: businessDateKey(now), total_posts_today: 0 },
                zalo_session: {
                    connected: false,
                    last_connected_at: null,
                    last_message_at: null,
                    last_error: null,
                },
                fb_session: { logged_in: false, last_checked_at: null, last_error: null },
                updated_at: now,
            },
        },
        { upsert: true },
    );
}

/** Cộng dồn số liệu ngày hôm nay. Ghi ngay khi có sự kiện vì post_history sẽ bị TTL xoá. */
export async function incrementDailyMetric(
    field: keyof Omit<import("../models/dailyMetrics.model.js").DailyMetricsDoc, "_id" | "updated_at">,
    amount = 1,
): Promise<void> {
    await dailyMetrics().updateOne(
        { _id: businessDateKey() },
        { $inc: { [field]: amount }, $set: { updated_at: new Date() } },
        { upsert: true },
    );
}
