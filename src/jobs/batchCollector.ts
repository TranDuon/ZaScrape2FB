/**
 * Gom job thành lô trước khi gọi Gemini.
 *
 * Lý do tồn tại là hạn ngạch: gói miễn phí tính theo SỐ LẦN GỌI mỗi ngày mỗi model, không theo
 * token. Gọi riêng từng tin nghĩa là mỗi tin ăn trọn một lượt; gom 5 tin vào một lần gọi thì
 * cùng hạn ngạch đó xử lý được gấp 5 lần số tin. Xem "Gộp lô lời gọi Gemini" trong CLAUDE.md.
 *
 * Đánh đổi: tin đầu tiên của lô phải chờ tối đa `windowMs` trước khi được xử lý. Chấp nhận được
 * vì phía sau còn giãn cách đăng bài 5-20 phút mỗi group và khung giờ hoạt động — vài phút ở
 * bước này không phải là thứ quyết định tin đăng lên sớm hay muộn.
 */
import type { JobDoc, JobType } from "../models/job.model.js";
import { claimNextJobs, type ClaimOrder } from "./jobQueue.js";

export interface CollectBatchOptions {
    type: JobType;
    /** Đủ số này là chạy ngay, không chờ hết cửa sổ. */
    maxSize: number;
    /** Thời gian chờ gom thêm job, tính từ lúc nhận được job đầu tiên. 0 = không chờ. */
    windowMs: number;
    /** Nhịp quét lại hàng đợi trong lúc chờ. */
    pollIntervalMs: number;
    /** Dừng chờ sớm khi tiến trình đang tắt — không để shutdown bị treo cả cửa sổ gom. */
    shouldStop: () => boolean;
    /** Mặc định FIFO. Bước soạn bài dùng `newest_first` để không ưu tiên phòng đã ế. */
    order?: ClaimOrder;
}

/**
 * Nhận một lô job đến hạn.
 *
 * Job được nhận (chuyển sang `processing`) NGAY khi thấy, rồi mới chờ gom thêm — chứ không phải
 * chờ xong mới nhận. Giữ job trong lúc chờ là an toàn: nếu tiến trình chết giữa cửa sổ gom,
 * `requeueStaleJobs` sẽ trả `extract_listing`/`compose_post` về hàng đợi (hai loại này chạy lại
 * vô hại). Cửa sổ gom mặc định 5 phút, ngắn hơn nhiều so với mốc coi là kẹt (15 phút).
 *
 * Trả về mảng rỗng khi hàng đợi không có gì — nơi gọi tự quyết định nghỉ bao lâu.
 */
export async function collectJobBatch(options: CollectBatchOptions): Promise<JobDoc[]> {
    const jobs = await claimNextJobs(options.type, options.maxSize, options.order);

    // Hàng đợi rỗng thì không mở cửa sổ chờ: chờ khi chưa có gì trong tay chỉ làm chậm
    // tin đến sau mà không gom thêm được gì.
    if (jobs.length === 0) return [];
    if (jobs.length >= options.maxSize || options.windowMs <= 0) return jobs;

    const deadline = Date.now() + options.windowMs;

    while (jobs.length < options.maxSize && !options.shouldStop()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;

        await new Promise((resolve) => setTimeout(resolve, Math.min(options.pollIntervalMs, remaining)));

        jobs.push(...(await claimNextJobs(options.type, options.maxSize - jobs.length, options.order)));
    }

    return jobs;
}
