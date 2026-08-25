import cron, { type ScheduledTask } from "node-cron";
import { env } from "../config/env.js";
import type { NotifyFn } from "../jobs/postingWorker.js";
import { childLogger } from "../utils/logger.js";
import { runCycle } from "./scheduleLogic.js";

const log = childLogger("scheduler:cron");

/**
 * Độ trễ ngẫu nhiên tối đa cộng vào mỗi nhịp.
 *
 * Nhịp cron chạy đúng phút chẵn nghĩa là bài đăng luôn rơi vào 8:00, 8:02, 8:04...
 * Cộng nhiễu để mốc đăng không nằm trên lưới thời gian đều tăm tắp.
 */
const MAX_RANDOM_DELAY_MS = 45_000;

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
