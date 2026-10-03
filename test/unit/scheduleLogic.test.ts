import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock được đưa lên đầu file, nên hằng số factory dùng phải khai báo qua vi.hoisted.
const { LIMITS } = vi.hoisted(() => ({ LIMITS: { regular: 20, carryoverExtra: 5 } }));

// scheduleLogic đọc thẳng DB (appState/postJobs), rateLimiter và jobQueue/postingWorker —
// mock hết các phụ thuộc ngoài để test được 3 nhánh "skip" quan trọng nhất mà không cần
// Atlas thật. Đây là "bộ não" điều phối rate-limit/circuit-breaker nên đáng có test riêng.
const findOneMock = vi.fn();
const isWithinActiveHoursMock = vi.fn();
const dailyQuotaUsedMock = vi.fn();
const requeueStaleJobsMock = vi.fn();
const runPostingOnceMock = vi.fn();

vi.mock("../../src/db/collections.js", () => ({
    appState: () => ({ findOne: findOneMock }),
    postJobs: () => ({ countDocuments: vi.fn() }),
}));

vi.mock("../../src/facebook/rateLimiter.js", () => ({
    isWithinActiveHours: isWithinActiveHoursMock,
    dailyQuotaUsed: dailyQuotaUsedMock,
    // Cố định hạn mức trong test, không phụ thuộc .env đang đặt bao nhiêu.
    dailyQuotaLimits: () => LIMITS,
}));

vi.mock("../../src/jobs/jobQueue.js", () => ({
    requeueStaleJobs: requeueStaleJobsMock,
}));

vi.mock("../../src/jobs/postingWorker.js", () => ({
    runPostingOnce: runPostingOnceMock,
}));

const { runCycle } = await import("../../src/scheduler/scheduleLogic.js");

const notify = vi.fn();

const used = (regular: number, carryover = 0) => ({ regular, carryover });

type Attempt = "attempted" | "deferred" | "idle";

/**
 * `runPostingOnce(notify, scope)` trả về gì theo từng scope. `true` = có job đăng được (attempted),
 * `false`/bỏ trống = không có job đến hạn (idle), hoặc truyền thẳng "deferred".
 */
function jobsAvailable(scopes: { carryover?: boolean | Attempt; today?: boolean | Attempt }) {
    const toAttempt = (value: boolean | Attempt | undefined): Attempt =>
        value === true ? "attempted" : value === false || value === undefined ? "idle" : value;
    runPostingOnceMock.mockImplementation(async (_notify: unknown, scope: string) =>
        toAttempt(scope === "carryover" ? scopes.carryover : scopes.today),
    );
}

/**
 * `daily_counters` ở đây cố tình giữ giá trị CŨ (ngày hôm kia, đã đủ hạn mức) trong mọi
 * trường hợp: số bài hôm nay phải đến từ `dailyQuotaUsed()` — đi qua hàm duy nhất lật ngày —
 * chứ không phải từ document thô. Test nào để hai nguồn này trùng nhau sẽ không phát hiện
 * được lỗi tự khoá đã làm hệ thống ngừng đăng suốt 4/9-6/9/2026.
 */
function stateWith(overrides: { tripped?: boolean; reason?: string | null }) {
    return {
        circuit_breaker: { tripped: overrides.tripped ?? false, reason: overrides.reason ?? null },
        daily_counters: { date: "2026-09-04", total_posts_today: LIMITS.regular, carryover_posts_today: LIMITS.carryoverExtra },
    };
}

describe("scheduleLogic.runCycle", () => {
    beforeEach(() => {
        isWithinActiveHoursMock.mockReturnValue(true);
        dailyQuotaUsedMock.mockResolvedValue(used(0));
        requeueStaleJobsMock.mockResolvedValue(0);
        jobsAvailable({});
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

    it("hết cả suất thường lẫn suất bù -> skip tới ngày mai, không nhặt job nào", async () => {
        findOneMock.mockResolvedValue(stateWith({}));
        dailyQuotaUsedMock.mockResolvedValue(used(LIMITS.regular, LIMITS.carryoverExtra));

        const result = await runCycle(notify);

        expect(result.action).toBe("skipped");
        expect(result.reason).toContain(`${LIMITS.regular}/${LIMITS.regular}`);
        expect(runPostingOnceMock).not.toHaveBeenCalled();
    });

    it("có bài tồn đến hạn -> đăng bài tồn TRƯỚC, không đụng tới bài hôm nay", async () => {
        findOneMock.mockResolvedValue(stateWith({}));
        jobsAvailable({ carryover: true, today: true });

        const result = await runCycle(notify);

        expect(result.action).toBe("posted");
        expect(runPostingOnceMock).toHaveBeenCalledTimes(1);
        expect(runPostingOnceMock).toHaveBeenCalledWith(notify, "carryover");
        expect(requeueStaleJobsMock).toHaveBeenCalledTimes(1);
    });

    it("không có bài tồn -> mới tới bài hôm nay, vẫn chỉ đúng một job mỗi nhịp", async () => {
        findOneMock.mockResolvedValue(stateWith({}));
        dailyQuotaUsedMock.mockResolvedValue(used(LIMITS.regular - 1));
        jobsAvailable({ today: true });

        const result = await runCycle(notify);

        expect(result.action).toBe("posted");
        expect(runPostingOnceMock.mock.calls.map((call) => call[1])).toEqual(["carryover", "today"]);
    });

    it("hết suất thường nhưng còn suất bù -> vẫn đăng được bài tồn (không tính vào hạn mức ngày)", async () => {
        findOneMock.mockResolvedValue(stateWith({}));
        dailyQuotaUsedMock.mockResolvedValue(used(LIMITS.regular, 2));
        jobsAvailable({ carryover: true, today: true });

        const result = await runCycle(notify);

        expect(result.action).toBe("posted");
        expect(runPostingOnceMock.mock.calls.map((call) => call[1])).toEqual(["carryover"]);
    });

    it("hết suất thường, còn suất bù nhưng không có bài tồn -> skip, KHÔNG lấy bài hôm nay", async () => {
        findOneMock.mockResolvedValue(stateWith({}));
        dailyQuotaUsedMock.mockResolvedValue(used(LIMITS.regular, 0));
        jobsAvailable({ today: true });

        const result = await runCycle(notify);

        expect(result.action).toBe("skipped");
        expect(runPostingOnceMock.mock.calls.map((call) => call[1])).toEqual(["carryover"]);
    });

    it("bộ đếm ngày cũ đã đủ hạn mức -> vẫn đăng, vì số hôm nay đọc qua dailyQuotaUsed", async () => {
        // Chính là lỗi đã khoá hệ thống từ 4/9 đến 6/9/2026: app_state còn giữ
        // { date: "2026-09-04", total_posts_today: 10 }. Nếu runCycle đọc số thô đó, nó dừng
        // sớm và không bao giờ gọi tới checkPostingAllowed — nơi DUY NHẤT lật được bộ đếm
        // sang ngày mới. Chốt chặn tự khoá chính nó, vĩnh viễn, không log một dòng nào.
        findOneMock.mockResolvedValue(stateWith({}));
        dailyQuotaUsedMock.mockResolvedValue(used(0)); // hàm này đã lật ngày -> hôm nay 0 bài
        jobsAvailable({ today: true });

        const result = await runCycle(notify);

        expect(result.action).toBe("posted");
    });

    it("bài tồn đến hạn đều phải hoãn -> vẫn thử bài hôm nay trong CÙNG nhịp", async () => {
        findOneMock.mockResolvedValue(stateWith({}));
        jobsAvailable({ carryover: "deferred", today: true });

        const result = await runCycle(notify);

        expect(result.action).toBe("posted");
        expect(runPostingOnceMock.mock.calls.map((call) => call[1])).toEqual(["carryover", "today"]);
    });

    it("mọi job đến hạn đều phải hoãn -> skipped (không phải idle), để lý do hiện ở mức INFO", async () => {
        findOneMock.mockResolvedValue(stateWith({}));
        jobsAvailable({ carryover: "deferred", today: "deferred" });

        const result = await runCycle(notify);

        expect(result.action).toBe("skipped");
        expect(result.reason).toContain("hoãn");
    });

    it("không có job nào đến hạn -> idle", async () => {
        findOneMock.mockResolvedValue(stateWith({}));
        jobsAvailable({});

        const result = await runCycle(notify);

        expect(result.action).toBe("idle");
    });
});
