/**
 * Soi các thứ đang KẸT trong pipeline — công cụ chính để theo dõi trong lúc chạy thật vài ngày.
 * Chạy: npm run check:stuck [số giờ]     (mặc định 6 giờ)
 *
 * Khác với check:listings (liệt kê tin gần nhất), script này chỉ tìm thứ BẤT THƯỜNG: tin nằm mãi
 * ở trạng thái giữa chừng, job thất bại, lần đăng không rõ kết quả, cầu dao ngắt. Không có gì bất
 * thường thì in ra đúng một dòng "mọi thứ bình thường" — chạy hằng ngày lúc soak test chỉ mất 2 giây.
 *
 * Thoát mã 1 nếu phát hiện vấn đề, để tiện gắn vào cron/script cảnh báo nếu muốn.
 */
import { APP_STATE_ID } from "../src/config/constants.js";
import { env } from "../src/config/env.js";
import { closeMongo, connectMongo } from "../src/db/mongoClient.js";
import { appState, groups, listings, postHistory, postJobs } from "../src/db/collections.js";
import type { ListingStatus } from "../src/models/listing.model.js";
import { formatBusinessTime } from "../src/utils/time.js";

/**
 * Trạng thái mà tin đăng chỉ nên đi ngang qua, không được nằm lại.
 *
 * `needs_review` KHÔNG nằm trong danh sách này: nó đang chờ người duyệt, nằm lâu là bình thường —
 * được đếm riêng bên dưới như một con số cần biết, không phải một lỗi.
 */
const TRANSIENT_STATUSES: ListingStatus[] = ["received", "extracting", "parsed", "ready", "queued", "posting"];

const hours = Number(process.argv[2] ?? 6);
let problems = 0;

function section(title: string): void {
    console.log(`\n--- ${title} ---`);
}

function problem(message: string): void {
    problems++;
    console.log(`  [!] ${message}`);
}

/**
 * Hỏi agent đang chạy qua /health.
 *
 * Script này là tiến trình riêng nên không thấy được trạng thái trong bộ nhớ của agent — đặc biệt
 * là bot Telegram còn sống hay không, thứ KHÔNG thể tự báo qua Telegram khi nó chết. Gọi /health
 * là cách duy nhất biết được, và tiện thể phát hiện luôn trường hợp agent không hề chạy.
 */
async function checkAgentAlive(): Promise<void> {
    section("Agent");
    const url = `http://${env.HEALTH_CHECK_BIND}:${env.HEALTH_CHECK_PORT}/health`;

    let report: { telegram?: { configured: boolean; polling: boolean }; uptime_seconds?: number };
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        report = (await response.json()) as typeof report;
    } catch {
        console.log("  Agent KHÔNG chạy (không gọi được /health).");
        console.log("  -> Binh thuong neu ban chua bat. Dang soak test thi chay: npm run dev");
        return;
    }

    const uptime = Math.round((report.uptime_seconds ?? 0) / 60);
    console.log(`  Đang chạy (${uptime} phút)`);

    if (report.telegram?.configured && !report.telegram.polling) {
        problem("Bot Telegram ĐÃ CHẾT — mọi lệnh điều khiển ngừng hoạt động");
        console.log("      -> Mo cau dao bang dong lenh: npm run resume");
        console.log("      -> Kiem tra token va ket noi toi api.telegram.org, roi khoi dong lai agent");
    } else if (report.telegram?.configured) {
        console.log("  Bot Telegram: đang nhận lệnh bình thường");
    }
}

async function checkCircuitBreakers(): Promise<void> {
    section("Cầu dao");
    const state = await appState().findOne({ _id: APP_STATE_ID });

    if (state?.circuit_breaker.tripped) {
        problem(`Cầu dao FACEBOOK đang ngắt: ${state.circuit_breaker.reason ?? "không rõ lý do"}`);
        console.log("      -> Xem RUNBOOK.md muc 'Su co 1', xu ly xong go /resume");
    } else {
        console.log("  Facebook: bình thường");
    }

    if (state?.zalo_circuit_breaker.tripped) {
        problem(`Cầu dao ZALO đang ngắt: ${state.zalo_circuit_breaker.reason ?? "không rõ lý do"}`);
        console.log("      -> Xem RUNBOOK.md muc 'Su co 3'");
    } else {
        console.log(`  Zalo: ${state?.zalo_session.connected ? "đang kết nối" : "CHƯA kết nối"}`);
    }
}

async function checkStuckListings(): Promise<void> {
    section(`Tin đăng kẹt giữa chừng (quá ${hours} giờ)`);
    const cutoff = new Date(Date.now() - hours * 3_600_000);

    const stuck = await listings()
        .find({ status: { $in: TRANSIENT_STATUSES }, updated_at: { $lt: cutoff } })
        .sort({ updated_at: 1 })
        .toArray();

    if (stuck.length === 0) {
        console.log("  Không có tin nào kẹt.");
        return;
    }

    for (const listing of stuck) {
        const code = listing._id?.toHexString().slice(-6);
        const age = ((Date.now() - listing.updated_at.getTime()) / 3_600_000).toFixed(1);
        problem(`Tin ${code} kẹt ở "${listing.status}" đã ${age} giờ (cập nhật cuối: ${formatBusinessTime(listing.updated_at)})`);
    }
}

async function checkFailedJobs(): Promise<void> {
    section("Job thất bại (còn trong hạn lưu 7 ngày)");

    const failed = await postJobs().find({ status: "failed" }).sort({ finished_at: -1 }).limit(10).toArray();

    if (failed.length === 0) {
        console.log("  Không có job nào thất bại.");
        return;
    }

    for (const job of failed) {
        const code = job.payload.listing_id.toHexString().slice(-6);
        problem(`Job ${job.type} của tin ${code}: ${job.last_error ?? "không rõ lỗi"}`);
    }
}

async function checkOverdueJobs(): Promise<void> {
    section("Job đến hạn nhưng chưa chạy");
    // Job quá hạn hơn 1 giờ nghĩa là bộ điều phối không nhặt được nó — thường do cầu dao ngắt,
    // ngoài khung giờ, hoặc đã đủ hạn mức ngày. Ba lý do đó đều bình thường, nên chỉ báo để biết.
    const cutoff = new Date(Date.now() - 3_600_000);
    const overdue = await postJobs().countDocuments({ status: "pending", scheduled_at: { $lt: cutoff } });

    if (overdue === 0) console.log("  Không có job nào quá hạn.");
    else console.log(`  ${overdue} job đã quá hạn hơn 1 giờ (bình thường nếu ngoài khung giờ đăng hoặc đã đủ hạn mức ngày).`);
}

async function checkUnknownPosts(): Promise<void> {
    section("Lần đăng KHÔNG RÕ kết quả");

    const unknown = await postHistory().find({ status: "unknown" }).sort({ posted_at: -1 }).toArray();

    if (unknown.length === 0) {
        console.log("  Không có.");
        return;
    }

    for (const record of unknown) {
        const group = await groups().findOne({ _id: record.group_id });
        const code = record.listing_id.toHexString().slice(-6);
        problem(`Tin ${code} / nhóm "${group?.name ?? "?"}" lúc ${formatBusinessTime(record.posted_at)}`);
        console.log("      -> Mo nhom xem bai da len chua. Chua co thi /retry, co roi thi thoi.");
    }
}

async function checkQueueDepth(): Promise<void> {
    section("Tình hình chung");

    const [needsReview, pending, processing, queued] = await Promise.all([
        listings().countDocuments({ status: "needs_review" }),
        postJobs().countDocuments({ status: "pending" }),
        postJobs().countDocuments({ status: "processing" }),
        listings().countDocuments({ status: "queued" }),
    ]);

    console.log(`  Tin chờ người duyệt: ${needsReview}`);
    console.log(`  Tin đã xếp lịch đăng: ${queued}`);
    console.log(`  Job đang chờ: ${pending} | đang chạy: ${processing}`);

    // Nhiều tin chờ duyệt không phải lỗi hệ thống, nhưng để lâu thì tin đăng phòng mất giá trị.
    if (needsReview >= 10) {
        problem(`Có ${needsReview} tin chờ duyệt — tin đăng phòng để lâu vài tiếng là mất giá trị`);
    }
}

async function main(): Promise<void> {
    await connectMongo();

    console.log(`=== KIỂM TRA TRẠNG THÁI KẸT (ngưỡng ${hours} giờ) ===`);
    console.log(`Thời điểm: ${formatBusinessTime()}`);

    await checkAgentAlive();
    await checkCircuitBreakers();
    await checkStuckListings();
    await checkFailedJobs();
    await checkOverdueJobs();
    await checkUnknownPosts();
    await checkQueueDepth();

    console.log(
        problems === 0
            ? "\n=== MỌI THỨ BÌNH THƯỜNG ==="
            : `\n=== PHÁT HIỆN ${problems} VẤN ĐỀ CẦN XEM (chi tiết cách xử lý: RUNBOOK.md) ===`,
    );

    await closeMongo();
    process.exit(problems === 0 ? 0 : 1);
}

main().catch(async (error) => {
    console.error("Kiểm tra thất bại:", error instanceof Error ? error.message : error);
    await closeMongo();
    process.exit(1);
});
