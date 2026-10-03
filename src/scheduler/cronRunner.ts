import cron, { type ScheduledTask } from "node-cron";
import { env } from "../config/env.js";
import type { NotifyFn } from "../jobs/postingWorker.js";
import { childLogger } from "../utils/logger.js";
import { runCycle } from "./scheduleLogic.js";

const log = childLogger("scheduler:cron");

/**
 * Độ trễ ngẫu nhiên tối đa cộng vào mỗi nhịp.
 *
 * Nhịp cron chạy đúng phút chẵn nghĩa là bài đăng luôn rơi vào :00, :20, :40 — chỉ ba giá trị
 * phút trong cả ngày, và đó tự nó là một dấu hiệu máy móc dù khoảng cách giữa các bài có thay đổi.
 * Mô phỏng 4000 ngày: nhiễu 45s cho ra 3 giá trị phút khác nhau, nhiễu 5 phút cho ra 15.
 *
 * RÀNG BUỘC: sàn cứng giữa hai bài = (nhịp cron − nhiễu này). Ở nhịp 20 phút, nhiễu 5 phút giữ
 * sàn ở 15 phút. Nâng nhiễu lên nữa là ăn thẳng vào sàn đó — nếu đổi `SCHEDULER_TICK_CRON`, phải
 * tính lại hiệu này chứ không được để nó tự trôi.
 */
const MAX_RANDOM_DELAY_MS = 5 * 60_000;

let task: ScheduledTask | null = null;

/**
 * Chạy vòng điều phối theo nhịp cố định.
 *
 * Dùng cron thay vì setInterval để nhịp bám theo đồng hồ thật: sau khi máy ngủ dậy
 * hoặc tiến trình khởi động lại, nhịp không bị trôi dần đi.
 */
export function startScheduler(notify: NotifyFn): void {
    if (!cron.validate(env.SCHEDULER_TICK_CRON)) {
        throw new Error(`SCHEDULER_TICK_CRON không hợp lệ: "${env.SCHEDULER_TICK_CRON}"`);
    }

    task = cron.schedule(
        env.SCHEDULER_TICK_CRON,
        async () => {
            try {
                const result = await runCycle(notify);

                if (result.action === "posted") {
                    log.info({ reason: result.reason }, "Nhịp điều phối đã xử lý một job");
                } else if (result.action === "skipped") {
                    // INFO chứ không phải debug: "skipped" là một quyết định DỪNG đăng bài, và
                    // LOG_LEVEL mặc định là info. Khi lỗi bộ đếm ngày khoá hệ thống từ 4/9/2026
                    // đến 6/9/2026, mỗi nhịp đều trả về skipped với lý do "đã đủ bài hôm nay" —
                    // ở mức debug thì hai ngày im lặng hoàn toàn không để lại một dòng log nào.
                    // Lặp lại cùng một lý do 40 lần/ngày mà không có bài nào lên là dấu hiệu rõ ràng.
                    log.info({ reason: result.reason }, "Nhịp điều phối bỏ qua");
                } else {
                    log.debug({ action: result.action, reason: result.reason }, "Nhịp điều phối");
                }
            } catch (error) {
                log.error({ err: error }, "Nhịp điều phối lỗi");
            }
        },
        {
            timezone: env.TZ,
            // Nhịp trước chưa xong thì bỏ qua nhịp này: đăng bài có thể mất hàng chục giây,
            // để hai lượt chồng nhau sẽ mở hai trình duyệt cùng lúc.
            noOverlap: true,
            maxRandomDelay: MAX_RANDOM_DELAY_MS,
        },
    );

    log.info(
        { cron: env.SCHEDULER_TICK_CRON, timezone: env.TZ, max_random_delay_ms: MAX_RANDOM_DELAY_MS },
        "Bộ điều phối đã khởi động",
    );
}

export async function stopScheduler(): Promise<void> {
    if (!task) return;

    await task.stop();
    task = null;
    log.info("Đã dừng bộ điều phối");
}
