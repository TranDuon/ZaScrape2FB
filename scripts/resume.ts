/**
 * Mở lại cầu dao đăng bài Facebook bằng dòng lệnh — bản dự phòng của lệnh /resume trên Telegram.
 * Chạy: npm run resume            (mở cầu dao Facebook)
 *       npm run resume -- --zalo  (mở cầu dao Zalo)
 *       npm run resume -- --status (chỉ xem, không đổi gì)
 *
 * VÌ SAO CẦN: `/resume` là cách DUY NHẤT mở cầu dao Facebook, mà nó lại đi qua Telegram. Nếu bot
 * Telegram chết (token bị thu hồi, hoặc ISP chặn api.telegram.org — chuyện không hiếm ở Việt Nam)
 * đúng lúc cầu dao đang ngắt thì agent kẹt cứng vĩnh viễn, không còn đường phục hồi nào ngoài sửa
 * tay trong MongoDB. Script này là đường thoát đó.
 *
 * Giữ nguyên tinh thần của thiết kế: cầu dao KHÔNG BAO GIỜ tự mở. Vẫn phải có người chủ động chạy
 * lệnh này, và vẫn phải tự kiểm tra Facebook trước.
 */
import { APP_STATE_ID } from "../src/config/constants.js";
import { appState } from "../src/db/collections.js";
import { closeMongo, connectMongo } from "../src/db/mongoClient.js";
import { formatBusinessTime } from "../src/utils/time.js";

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const zalo = args.includes("--zalo");
    const statusOnly = args.includes("--status");

    await connectMongo();

    const state = await appState().findOne({ _id: APP_STATE_ID });
    if (!state) {
        console.error("Chưa có document app_state — agent chưa từng chạy lần nào?");
        await closeMongo();
        process.exit(1);
    }

    const fb = state.circuit_breaker;
    const zl = state.zalo_circuit_breaker;

    console.log("\n=== TRẠNG THÁI CẦU DAO ===");
    console.log(`Facebook: ${fb.tripped ? "ĐANG NGẮT" : "bình thường"}`);
    if (fb.tripped) {
        console.log(`  Lý do:  ${fb.reason ?? "không rõ"}`);
        console.log(`  Từ lúc: ${fb.tripped_at ? formatBusinessTime(fb.tripped_at) : "không rõ"}`);
    }
    console.log(`Zalo:     ${zl.tripped ? "ĐANG NGẮT" : "bình thường"}`);
    if (zl.tripped) console.log(`  Lý do:  ${zl.reason ?? "không rõ"}`);

    if (statusOnly) {
        await closeMongo();
        return;
    }

    const target = zalo ? "zalo_circuit_breaker" : "circuit_breaker";
    const label = zalo ? "Zalo" : "Facebook";
    const wasTripped = zalo ? zl.tripped : fb.tripped;

    if (!wasTripped) {
        console.log(`\nCầu dao ${label} vốn đã không ngắt — không cần làm gì.`);
        await closeMongo();
        return;
    }

    // Nhắc lại việc bắt buộc phải làm trước: mở cầu dao trong lúc Facebook vẫn đang chặn
    // là cách nhanh nhất biến một checkpoint thành khoá tài khoản.
    console.log(`\nBạn ĐÃ tự mở ${label} kiểm tra và xử lý xong chưa?`);
    console.log("(Mở cầu dao trong lúc còn bị hạn chế sẽ làm tình hình tệ hơn)");
    console.log("\nĐang mở cầu dao sau 5 giây... Ctrl+C để huỷ.");
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    await appState().updateOne(
        { _id: APP_STATE_ID },
        {
            $set: {
                [`${target}.tripped`]: false,
                [`${target}.reason`]: null,
                [`${target}.tripped_at`]: null,
                updated_at: new Date(),
            },
        },
    );

    console.log(`\nĐã mở cầu dao ${label}.`);
    console.log(
        zalo
            ? "Khởi động lại agent để kết nối Zalo lại: npm run dev"
            : "Agent sẽ tiếp tục đăng bài ở nhịp điều phối tiếp theo (không cần khởi động lại).",
    );

    await closeMongo();
}

main().catch(async (error) => {
    console.error("Mở cầu dao thất bại:", error instanceof Error ? error.message : error);
    await closeMongo();
    process.exit(1);
});
