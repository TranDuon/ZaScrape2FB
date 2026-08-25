import { groups, listings, postHistory } from "../db/collections.js";
import type { NotifyFn } from "../jobs/postingWorker.js";
import { childLogger } from "../utils/logger.js";
import { formatBusinessTime } from "../utils/time.js";

const log = childLogger("maintenance:stale-post");

/**
 * Bản ghi `attempting` lâu hơn mốc này coi như tiến trình xử lý nó đã chết.
 *
 * Rộng rãi hơn nhiều so với thời gian đăng thật (vài chục giây): thà báo muộn còn hơn báo nhầm
 * một bài đang đăng dở là "không rõ kết quả" trong lúc Playwright vẫn đang gõ.
 */
const STALE_ATTEMPT_MS = 20 * 60 * 1000;

/**
 * Tìm các lần đăng treo ở `attempting` và báo người dùng tự kiểm tra.
 *
 * `postingWorker` ghi `attempting` TRƯỚC khi Playwright chạm vào bất cứ thứ gì. Nếu tiến trình
 * chết sau khi bấm Đăng nhưng trước khi ghi kết quả, bản ghi nằm lại ở `attempting` vĩnh viễn —
 * và đó chính là bằng chứng duy nhất cho biết "có thể có một bài đã lên Facebook mà hệ thống
 * không hay biết".
 *
 * CỐ Ý không tự đăng lại: đăng trùng cùng một nội dung vào cùng một nhóm còn tệ hơn nhiều so với
 * việc bỏ sót một bài. Việc duy nhất làm ở đây là chuyển sang `unknown` và nói cho người dùng
 * biết cần mở nhóm nào ra xem.
 */
export async function sweepStaleAttempts(notify: NotifyFn): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_ATTEMPT_MS);

    const stale = await postHistory()
        .find({ status: "attempting", posted_at: { $lt: cutoff } })
        .toArray();

    if (stale.length === 0) return 0;

    for (const record of stale) {
        await postHistory().updateOne(
            { _id: record._id },
            {
                $set: {
                    status: "unknown",
                    error_message: "Tiến trình chết giữa lúc đăng — không xác định được bài đã lên hay chưa",
                },
            },
        );

        const group = await groups().findOne({ _id: record.group_id });
        const listing = await listings().findOne({ _id: record.listing_id });

        const lines = [
            "❓ KHÔNG RÕ KẾT QUẢ MỘT LẦN ĐĂNG",
            "",
            `Nhóm: ${group?.name ?? "(không còn trong DB)"}`,
            `Mã tin: ${record.listing_id.toHexString().slice(-6)}`,
            `Bắt đầu đăng lúc: ${formatBusinessTime(record.posted_at)}`,
            `Địa chỉ phòng: ${listing?.parsed_data?.address.raw ?? listing?.parsed_data?.address.district ?? "chưa rõ"}`,
            "",
            "Agent chết giữa lúc đang đăng nên không biết bài đã lên Facebook hay chưa.",
            "",
            "Việc cần làm:",
            `1. Mở nhóm "${group?.name ?? "?"}" xem bài đã có chưa`,
            "2. Nếu CHƯA có, gõ /retry <mã tin> để đăng lại",
            "3. Nếu ĐÃ có, không cần làm gì",
            "",
            "Agent sẽ KHÔNG tự đăng lại — đăng trùng vào cùng một nhóm tệ hơn là bỏ sót.",
        ];

        await notify(lines.join("\n"));
    }

    log.warn({ count: stale.length }, "Có lần đăng không rõ kết quả, đã báo người dùng kiểm tra tay");
    return stale.length;
}
