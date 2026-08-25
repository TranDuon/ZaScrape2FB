import { ObjectId } from "mongodb";
import { env } from "../config/env.js";
import { APP_STATE_ID } from "../config/constants.js";
import { appState, dailyMetrics, groups, listings, postJobs } from "../db/collections.js";
import { enqueueJob } from "../jobs/jobQueue.js";
import { recomposeListing } from "../listings/recompose.js";
import type { ListingDoc, ListingStatus } from "../models/listing.model.js";
import { childLogger } from "../utils/logger.js";
import { businessDateKey, formatBusinessTime } from "../utils/time.js";
import { registerCallbackHandler, registerCommand } from "../notifier/telegramBot.js";

const log = childLogger("review");

/**
 * Người dùng gõ 6 ký tự cuối của id cho nhanh trên điện thoại, nhưng cũng chấp nhận
 * id đầy đủ khi copy từ log.
 */
async function findListing(code: string): Promise<ListingDoc | null> {
    const trimmed = code.trim();

    if (ObjectId.isValid(trimmed) && trimmed.length === 24) {
        return (await listings().findOne({ _id: new ObjectId(trimmed) })) as ListingDoc | null;
    }

    if (!/^[0-9a-f]{4,24}$/i.test(trimmed)) return null;

    // Không có cách nào truy vấn theo hậu tố ObjectId, nên quét các tin gần đây —
    // chấp nhận được vì tin cần duyệt luôn là tin mới.
    const recent = (await listings().find().sort({ created_at: -1 }).limit(200).toArray()) as ListingDoc[];
    return recent.find((doc) => doc._id?.toHexString().endsWith(trimmed.toLowerCase())) ?? null;
}

async function setStatus(listingId: ObjectId, status: ListingStatus, note: string): Promise<void> {
    const now = new Date();
    await listings().updateOne(
        { _id: listingId },
        {
            $set: { status, updated_at: now, "review.reviewed_at": now },
            $push: { status_history: { status, at: now, note } },
        },
    );
}

async function approve(code: string): Promise<string> {
    const listing = await findListing(code);
    if (!listing) return `Không tìm thấy tin đăng "${code}"`;

    const listingId = listing._id as ObjectId;

    if (listing.status !== "needs_review") {
        return `Tin đăng đang ở trạng thái "${listing.status}", không phải chờ duyệt.`;
    }

    await listings().updateOne({ _id: listingId }, { $set: { "review.action": "approved" } });
    await setStatus(listingId, "ready", "Người dùng duyệt qua Telegram");
    await enqueueJob({ type: "compose_post", listingId });

    log.info({ listing_id: listingId }, "Tin đăng được duyệt");
    return `✅ Đã duyệt. Đang soạn bài đăng...`;
}

async function reject(code: string): Promise<string> {
    const listing = await findListing(code);
    if (!listing) return `Không tìm thấy tin đăng "${code}"`;

    const listingId = listing._id as ObjectId;
    await listings().updateOne({ _id: listingId }, { $set: { "review.action": "rejected" } });
    await setStatus(listingId, "rejected", "Người dùng từ chối qua Telegram");

    return "❌ Đã bỏ qua tin này.";
}

/**
 * Sửa một trường dữ liệu rồi soạn lại bài.
 *
 * Cú pháp: /edit <mã> <trường>=<giá trị>
 * Ví dụ:   /edit a1b2c3 price_vnd=4500000
 */
async function edit(args: string[]): Promise<string> {
    const [code, ...rest] = args;
    if (!code || rest.length === 0) {
        return "Cú pháp: /edit <mã> <trường>=<giá trị>\nVí dụ: /edit a1b2c3 price_vnd=4500000";
    }

    const listing = await findListing(code);
    if (!listing) return `Không tìm thấy tin đăng "${code}"`;
    if (!listing.parsed_data) return "Tin này chưa được trích xuất, chưa sửa được.";

    const assignment = rest.join(" ");
    const separator = assignment.indexOf("=");
    if (separator < 0) return "Thiếu dấu = trong câu lệnh. Ví dụ: price_vnd=4500000";

    const field = assignment.slice(0, separator).trim();
    const rawValue = assignment.slice(separator + 1).trim();

    const numericFields = ["price_vnd", "area_m2", "deposit_vnd"];
    const textFields = ["title", "room_type", "contact_phone", "contact_name", "notes", "available_from"];
    const addressFields = ["address.raw", "address.ward", "address.district", "address.city"];

    let value: string | number;
    if (numericFields.includes(field)) {
        const parsed = Number(rawValue.replace(/[^\d.]/g, ""));
        if (!Number.isFinite(parsed)) return `Giá trị "${rawValue}" không phải số hợp lệ.`;
        value = parsed;
    } else if (textFields.includes(field) || addressFields.includes(field)) {
        value = rawValue;
    } else {
        return `Không sửa được trường "${field}".\nCác trường cho phép: ${[...numericFields, ...textFields, ...addressFields].join(", ")}`;
    }

    const listingId = listing._id as ObjectId;
    await listings().updateOne(
        { _id: listingId },
        { $set: { [`parsed_data.${field}`]: value, "review.action": "edited", updated_at: new Date() } },
    );

    // Nội dung đã soạn giờ không còn khớp dữ liệu — phải soạn lại.
    if (listing.status === "queued" || listing.status === "posting") {
        const result = await recomposeListing(listingId);
        return `✏️ Đã cập nhật ${field}.\n${result.message}`;
    }

    return `✏️ Đã cập nhật ${field} = ${value}`;
}

async function pause(): Promise<string> {
    const now = new Date();
    await appState().updateOne(
        { _id: APP_STATE_ID },
        {
            $set: {
                "circuit_breaker.tripped": true,
                "circuit_breaker.tripped_at": now,
                "circuit_breaker.reason": "Người dùng tạm dừng thủ công",
                updated_at: now,
            },
        },
    );

    return "⏸ Đã tạm dừng đăng bài. Gõ /resume để chạy lại.";
}

/**
 * Mở lại cầu dao.
 *
 * Đây là hành động DUY NHẤT mở được cầu dao — hệ thống không bao giờ tự mở.
 * Lời nhắc kiểm tra tài khoản là cố ý: người dùng hay gõ /resume theo phản xạ
 * mà chưa thực sự mở Facebook xem có chuyện gì.
 */
async function resume(): Promise<string> {
    const state = await appState().findOne({ _id: APP_STATE_ID });

    if (!state?.circuit_breaker.tripped) {
        return "Cầu dao đang bình thường, không cần mở lại.";
    }

    const previousReason = state.circuit_breaker.reason ?? "không rõ";
    const now = new Date();

    await appState().updateOne(
        { _id: APP_STATE_ID },
        {
            $set: {
                "circuit_breaker.tripped": false,
                "circuit_breaker.tripped_at": null,
                "circuit_breaker.reason": null,
                updated_at: now,
            },
        },
    );

    log.info({ previous_reason: previousReason }, "Cầu dao được mở lại thủ công");
    return `▶️ Đã chạy lại.\n\nLý do dừng trước đó: ${previousReason}\n\nNếu chưa kiểm tra tài khoản Facebook, hãy làm ngay — dừng lại là có lý do.`;
}

async function status(): Promise<string> {
    const state = await appState().findOne({ _id: APP_STATE_ID });

    const byStatus = await listings()
        .aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }])
        .toArray();

    const jobCounts = await postJobs()
        .aggregate<{ _id: string; n: number }>([
            { $match: { status: { $in: ["pending", "processing"] } } },
            { $group: { _id: "$type", n: { $sum: 1 } } },
        ])
        .toArray();

    const activeGroups = await groups().countDocuments({ active: true });

    const lines = [
        "📊 TRẠNG THÁI HỆ THỐNG",
        "",
        `Zalo: ${state?.zalo_session.connected ? "đang kết nối" : "MẤT KẾT NỐI"}`,
        state?.zalo_circuit_breaker.tripped ? `  ⚠️ Cầu dao Zalo ngắt: ${state.zalo_circuit_breaker.reason}` : "",
        `Facebook: ${state?.circuit_breaker.tripped ? `⚠️ ĐANG DỪNG (${state.circuit_breaker.reason})` : "bình thường"}`,
        `Group đang bật: ${activeGroups}`,
        `Đã đăng hôm nay: ${state?.daily_counters.total_posts_today ?? 0}/${env.MAX_POSTS_PER_DAY}`,
        "",
        "Tin đăng:",
        ...byStatus.map((row) => `  ${row._id}: ${row.n}`),
        "",
        "Job đang chờ:",
        ...(jobCounts.length > 0 ? jobCounts.map((row) => `  ${row._id}: ${row.n}`) : ["  (không có)"]),
        "",
        `Lúc: ${formatBusinessTime()}`,
    ];

    return lines.filter(Boolean).join("\n");
}

async function stats(): Promise<string> {
    // Đọc từ daily_metrics chứ không tính lại từ post_history: lịch sử chi tiết
    // bị TTL xoá sau 7 ngày, còn số liệu tổng hợp thì giữ mãi.
    const recent = await dailyMetrics().find().sort({ _id: -1 }).limit(7).toArray();

    if (recent.length === 0) return "Chưa có số liệu nào.";

    const lines = ["📈 THỐNG KÊ 7 NGÀY GẦN NHẤT", ""];

    for (const day of recent) {
        const isToday = day._id === businessDateKey();
        const avgExtract = day.extraction_count > 0 ? Math.round(day.extraction_time_ms_total / day.extraction_count) : 0;

        lines.push(
            `${day._id}${isToday ? " (hôm nay)" : ""}`,
            `  nhận ${day.listings_received ?? 0} | bỏ qua ${day.listings_ignored ?? 0}`,
            `  đăng thành công ${day.posts_success ?? 0} | thất bại ${day.posts_failed ?? 0}`,
            avgExtract > 0 ? `  trích xuất trung bình ${(avgExtract / 1000).toFixed(1)}s` : "",
            "",
        );
    }

    return lines.filter((line) => line !== undefined).join("\n");
}

async function retry(code: string): Promise<string> {
    const listing = await findListing(code);
    if (!listing) return `Không tìm thấy tin đăng "${code}"`;

    const listingId = listing._id as ObjectId;
    const result = await recomposeListing(listingId);

    return result.ok ? `🔄 ${result.message}` : `Không thử lại được: ${result.message}`;
}
async function clear(): Promise<string> {
    // Bạn có thể viết logic xoá dữ liệu trong DB ở đây nếu muốn
    return "Đã xoá lịch sử thông báo cho anh iuu ";
}

function help(): string {
    return [
        "📖 CÁC LỆNH",
        "",
        "/status — tình trạng hệ thống",
        "/stats — thống kê 7 ngày",
        "/approve <mã> — duyệt tin chờ",
        "/reject <mã> — bỏ qua tin",
        "/edit <mã> <trường>=<giá trị> — sửa dữ liệu rồi soạn lại",
        "/retry <mã> — soạn lại và xếp lịch đăng lại",
        "/pause — tạm dừng đăng bài",
        "/resume — chạy lại sau khi đã kiểm tra tài khoản",
        "/clear — Dọn dẹp dữ liệu",
        "",
        "Mã tin là 6 ký tự cuối của id, hiện trong thông báo.",
    ].join("\n");
}

/** Gắn toàn bộ lệnh và nút bấm vào bot. Gọi một lần lúc khởi động. */
export function registerReviewCommands(): void {
    registerCommand("start", () => help());
    registerCommand("help", () => help());
    registerCommand("status", () => status());
    registerCommand("stats", () => stats());
    registerCommand("clear", () => clear());
    registerCommand("approve", (args) => approve(args[0] ?? ""));
    registerCommand("reject", (args) => reject(args[0] ?? ""));
    registerCommand("edit", (args) => edit(args));
    registerCommand("retry", (args) => retry(args[0] ?? ""));
    registerCommand("pause", () => pause());
    registerCommand("resume", () => resume());

    registerCallbackHandler(async (action, payload) => {
        switch (action) {
            case "approve":
                return approve(payload);
            case "reject":
                return reject(payload);
            default:
                return `Không hiểu thao tác "${action}"`;
        }
    });
}
