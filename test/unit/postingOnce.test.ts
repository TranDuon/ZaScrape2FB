import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// runPostingOnce: job đến lượt bị HOÃN thì nhặt tiếp job kế trong cùng lượt, nhưng không bao giờ chạm
// Facebook quá MỘT lần mỗi lượt. Mock mọi thứ bên ngoài — thứ cần kiểm là vòng lặp, không phải Mongo
// hay Playwright.
const claimNextJobMock = vi.fn();
const failJobMock = vi.fn();
const checkPostingAllowedMock = vi.fn();
const newPageMock = vi.fn();
const checkSessionMock = vi.fn();
const appStateFindOneMock = vi.fn();

vi.mock("../../src/db/collections.js", () => ({
    appState: () => ({ findOne: appStateFindOneMock, updateOne: vi.fn() }),
    groups: () => ({ findOne: async () => ({ _id: "g", name: "Nhóm thử", url: "https://facebook.com/groups/x" }) }),
    listings: () => ({ findOne: async () => ({ _id: "l", status: "queued", images: [] }), updateOne: vi.fn() }),
    postHistory: () => ({ insertOne: async () => ({ insertedId: "h" }), updateOne: vi.fn() }),
    postJobs: () => ({ updateOne: vi.fn(), aggregate: () => ({ toArray: async () => [] }) }),
}));
vi.mock("../../src/db/indexes.js", () => ({ incrementDailyMetric: vi.fn() }));
vi.mock("../../src/facebook/fbBrowser.js", () => ({ newPage: newPageMock, checkSession: checkSessionMock }));
vi.mock("../../src/facebook/fbPoster.js", () => ({ CheckpointError: class extends Error {}, postToGroup: vi.fn() }));
vi.mock("../../src/facebook/rateLimiter.js", () => ({
    checkPostingAllowed: checkPostingAllowedMock,
    recordSuccessfulPost: vi.fn(),
}));
vi.mock("../../src/notifier/notifyEvents.js", () => ({ listingLabel: () => "phòng thử" }));
vi.mock("../../src/jobs/jobQueue.js", () => ({
    claimNextJob: claimNextJobMock,
    completeJob: vi.fn(),
    failJob: failJobMock,
}));

const { runPostingOnce } = await import("../../src/jobs/postingWorker.js");

const notify = vi.fn();
const ALLOWED = { allowed: true, reason: "ok", retryAt: null };
const WAIT = { allowed: false, reason: "Mới đăng vào group này 20 phút trước", retryAt: new Date(Date.now() + 3_600_000) };

let seq = 0;
function job() {
    seq += 1;
    return {
        _id: `job-${seq}`,
        type: "post_to_group",
        created_at: new Date(),
        attempts: 1,
        payload: { listing_id: "l", group_id: "g", composed_text: "nội dung" },
    };
}

describe("postingWorker.runPostingOnce", () => {
    beforeEach(() => {
        appStateFindOneMock.mockResolvedValue({ circuit_breaker: { tripped: false } });
        failJobMock.mockResolvedValue("retry");
        newPageMock.mockResolvedValue({});
        // Phiên hỏng: đường ngắn nhất đi tới "đã chạm Facebook" mà không cần giả lập cả lần đăng.
        checkSessionMock.mockResolvedValue({ loggedIn: false, reason: "thử" });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("không có job đến hạn -> idle, không mở trình duyệt", async () => {
        claimNextJobMock.mockResolvedValue(null);

        expect(await runPostingOnce(notify, "today")).toBe("idle");
        expect(newPageMock).not.toHaveBeenCalled();
    });

    it("job đầu phải hoãn -> nhặt tiếp job kế trong CÙNG lượt, và chạm Facebook đúng một lần", async () => {
        claimNextJobMock.mockImplementation(async () => job());
        checkPostingAllowedMock.mockResolvedValueOnce(WAIT).mockResolvedValue(ALLOWED);

        expect(await runPostingOnce(notify, "today")).toBe("attempted");
        expect(claimNextJobMock).toHaveBeenCalledTimes(2);
        expect(newPageMock).toHaveBeenCalledTimes(1);
    });

    it("job đầu đã chạm Facebook (kể cả lỗi) -> dừng lượt, KHÔNG thử job khác", async () => {
        claimNextJobMock.mockImplementation(async () => job());
        checkPostingAllowedMock.mockResolvedValue(ALLOWED);

        expect(await runPostingOnce(notify, "today")).toBe("attempted");
        expect(claimNextJobMock).toHaveBeenCalledTimes(1);
        expect(newPageMock).toHaveBeenCalledTimes(1);
    });

    it("mọi job đều phải hoãn -> deferred, có trần số job xét trong một lượt, không mở trình duyệt", async () => {
        claimNextJobMock.mockImplementation(async () => job());
        checkPostingAllowedMock.mockResolvedValue(WAIT);

        expect(await runPostingOnce(notify, "today")).toBe("deferred");
        expect(claimNextJobMock.mock.calls.length).toBeLessThanOrEqual(6);
        expect(newPageMock).not.toHaveBeenCalled();
    });

    it("hết job sau vài lần hoãn -> deferred (có job đến hạn, chỉ là đều phải chờ)", async () => {
        claimNextJobMock.mockResolvedValueOnce(job()).mockResolvedValueOnce(job()).mockResolvedValue(null);
        checkPostingAllowedMock.mockResolvedValue(WAIT);

        expect(await runPostingOnce(notify, "today")).toBe("deferred");
        expect(claimNextJobMock).toHaveBeenCalledTimes(3);
    });

    it("cầu dao ngắt -> không nhặt job nào", async () => {
        appStateFindOneMock.mockResolvedValue({ circuit_breaker: { tripped: true } });

        expect(await runPostingOnce(notify, "today")).toBe("idle");
        expect(claimNextJobMock).not.toHaveBeenCalled();
    });
});
