import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { JobDoc } from "../../src/models/job.model.js";

/**
 * Cửa sổ gom lô quyết định đánh đổi "tiết kiệm hạn ngạch <-> tin đăng bị chậm", nên các nhánh
 * của nó cần chắc chắn: không chờ khi không có gì để chờ, không chờ khi đã đủ lô, và không giữ
 * tiến trình lại khi đang tắt máy.
 *
 * jobQueue được mock — ở đây chỉ kiểm tra logic chờ/gom, phần nhận job nguyên tử đã có
 * test/jobQueue.integration.ts chạy với Atlas thật lo.
 */
const claimNextJobsMock = vi.fn();

vi.mock("../../src/jobs/jobQueue.js", () => ({
    claimNextJobs: claimNextJobsMock,
}));

const { collectJobBatch } = await import("../../src/jobs/batchCollector.js");

function fakeJob(): JobDoc {
    return {
        _id: new ObjectId(),
        type: "extract_listing",
        status: "processing",
        payload: { listing_id: new ObjectId(), group_id: null, composed_text: null },
        attempts: 1,
        attempt_seq: 0,
        max_attempts: 3,
        idempotency_key: new ObjectId().toHexString(),
        last_error: null,
        scheduled_at: new Date(),
        claimed_at: new Date(),
        claimed_by: "test",
        started_at: new Date(),
        finished_at: null,
        created_at: new Date(),
        updated_at: new Date(),
    };
}

function options(overrides: Partial<Parameters<typeof collectJobBatch>[0]> = {}) {
    return {
        type: "extract_listing" as const,
        maxSize: 3,
        windowMs: 200,
        pollIntervalMs: 10,
        shouldStop: () => false,
        ...overrides,
    };
}

describe("collectJobBatch", () => {
    beforeEach(() => {
        claimNextJobsMock.mockReset();
    });

    it("hàng đợi rỗng thì trả về ngay, KHÔNG mở cửa sổ chờ", async () => {
        claimNextJobsMock.mockResolvedValue([]);

        const started = Date.now();
        const jobs = await collectJobBatch(options({ windowMs: 5_000 }));

        expect(jobs).toEqual([]);
        // Chờ khi tay trắng chỉ làm chậm tin đến sau mà không gom thêm được gì.
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(claimNextJobsMock).toHaveBeenCalledTimes(1);
    });

    it("đủ lô ngay từ đầu thì chạy luôn, không chờ hết cửa sổ", async () => {
        claimNextJobsMock.mockResolvedValue([fakeJob(), fakeJob(), fakeJob()]);

        const started = Date.now();
        const jobs = await collectJobBatch(options({ maxSize: 3, windowMs: 5_000 }));

        expect(jobs).toHaveLength(3);
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(claimNextJobsMock).toHaveBeenCalledTimes(1);
    });

    it("chưa đủ lô thì chờ và gom thêm job đến sau", async () => {
        claimNextJobsMock
            .mockResolvedValueOnce([fakeJob()])
            .mockResolvedValueOnce([fakeJob()])
            .mockResolvedValue([]);

        const jobs = await collectJobBatch(options({ maxSize: 3, windowMs: 120, pollIntervalMs: 20 }));

        expect(jobs.length).toBeGreaterThanOrEqual(2);
        expect(claimNextJobsMock.mock.calls.length).toBeGreaterThan(1);
    });

    it("dừng chờ sớm khi đủ maxSize giữa cửa sổ", async () => {
        claimNextJobsMock.mockResolvedValueOnce([fakeJob()]).mockResolvedValueOnce([fakeJob(), fakeJob()]);

        const jobs = await collectJobBatch(options({ maxSize: 3, windowMs: 10_000, pollIntervalMs: 10 }));

        expect(jobs).toHaveLength(3);
        expect(claimNextJobsMock).toHaveBeenCalledTimes(2);
    });

    it("windowMs = 0 thì không chờ, lấy được bao nhiêu dùng bấy nhiêu", async () => {
        claimNextJobsMock.mockResolvedValue([fakeJob()]);

        const jobs = await collectJobBatch(options({ maxSize: 5, windowMs: 0 }));

        expect(jobs).toHaveLength(1);
        expect(claimNextJobsMock).toHaveBeenCalledTimes(1);
    });

    it("đang tắt máy thì bỏ chờ, trả về job đã nhận được", async () => {
        claimNextJobsMock.mockResolvedValue([fakeJob()]);

        const started = Date.now();
        // Cửa sổ 10 giây nhưng shouldStop luôn true: không được để shutdown treo cả cửa sổ gom.
        const jobs = await collectJobBatch(options({ maxSize: 5, windowMs: 10_000, shouldStop: () => true }));

        expect(jobs).toHaveLength(1);
        expect(Date.now() - started).toBeLessThan(1_000);
    });
});
