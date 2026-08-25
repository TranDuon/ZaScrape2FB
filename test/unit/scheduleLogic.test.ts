import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// scheduleLogic đọc thẳng DB (appState/postJobs), rateLimiter và jobQueue/postingWorker —
// mock hết các phụ thuộc ngoài để test được 3 nhánh "skip" quan trọng nhất mà không cần
// Atlas thật. Đây là "bộ não" điều phối rate-limit/circuit-breaker nên đáng có test riêng.
const findOneMock = vi.fn();
const isWithinActiveHoursMock = vi.fn();
const requeueStaleJobsMock = vi.fn();
const runPostingOnceMock = vi.fn();

vi.mock("../../src/db/collections.js", () => ({
    appState: () => ({ findOne: findOneMock }),
    postJobs: () => ({ countDocuments: vi.fn() }),
}));

vi.mock("../../src/facebook/rateLimiter.js", () => ({
    isWithinActiveHours: isWithinActiveHoursMock,
}));

vi.mock("../../src/jobs/jobQueue.js", () => ({
    requeueStaleJobs: requeueStaleJobsMock,
}));

vi.mock("../../src/jobs/postingWorker.js", () => ({
    runPostingOnce: runPostingOnceMock,
}));

const { runCycle } = await import("../../src/scheduler/scheduleLogic.js");
const { env } = await import("../../src/config/env.js");

const notify = vi.fn();

function stateWith(overrides: {
    tripped?: boolean;
    reason?: string | null;
    totalPostsToday?: number;
}) {
    return {
        circuit_breaker: { tripped: overrides.tripped ?? false, reason: overrides.reason ?? null },
        daily_counters: { total_posts_today: overrides.totalPostsToday ?? 0 },
    };
}

describe("scheduleLogic.runCycle", () => {
    beforeEach(() => {
        isWithinActiveHoursMock.mockReturnValue(true);
        requeueStaleJobsMock.mockResolvedValue(0);
        runPostingOnceMock.mockResolvedValue(false);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("cầu dao đã ngắt -> skip ngay, không đụng tới rate limiter hay job", async () => {
        findOneMock.mockResolvedValue(stateWith({ tripped: true, reason: "checkpoint" }));

        const result = await runCycle(notify);

        expect(result.action).toBe("skipped");
        expect(result.reason).toContain("checkpoint");
        expect(isWithinActiveHoursMock).not.toHaveBeenCalled();
        expect(runPostingOnceMock).not.toHaveBeenCalled();
    });

    it("ngoài khung giờ hoạt động -> skip, không lấy job", async () => {
        findOneMock.mockResolvedValue(stateWith({}));
        isWithinActiveHoursMock.mockReturnValue(false);

        const result = await runCycle(notify);

        expect(result.action).toBe("skipped");
        expect(result.reason).toContain("Ngoài khung giờ");
        expect(runPostingOnceMock).not.toHaveBeenCalled();
    });

    it("đã đủ MAX_POSTS_PER_DAY -> skip tới ngày mai", async () => {
        findOneMock.mockResolvedValue(stateWith({ totalPostsToday: env.MAX_POSTS_PER_DAY }));

        const result = await runCycle(notify);

        expect(result.action).toBe("skipped");
        expect(result.reason).toContain(String(env.MAX_POSTS_PER_DAY));
        expect(runPostingOnceMock).not.toHaveBeenCalled();
    });

    it("còn hạn mức + trong khung giờ -> dọn job kẹt rồi lấy đúng một job", async () => {
        findOneMock.mockResolvedValue(stateWith({ totalPostsToday: env.MAX_POSTS_PER_DAY - 1 }));
        runPostingOnceMock.mockResolvedValue(true);

        const result = await runCycle(notify);

        expect(requeueStaleJobsMock).toHaveBeenCalledTimes(1);
        expect(runPostingOnceMock).toHaveBeenCalledTimes(1);
        expect(result.action).toBe("posted");
    });

    it("không có job nào đến hạn -> idle", async () => {
        findOneMock.mockResolvedValue(stateWith({}));
        runPostingOnceMock.mockResolvedValue(false);

        const result = await runCycle(notify);

        expect(result.action).toBe("idle");
    });
});
