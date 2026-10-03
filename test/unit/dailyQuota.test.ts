import { describe, expect, it } from "vitest";
import { isCarryoverJob, slotFor } from "../../src/facebook/dailyQuota.js";

const limits = { regular: 20, carryoverExtra: 5 };

describe("dailyQuota.slotFor", () => {
    it("bài thường chỉ dùng suất thường", () => {
        expect(slotFor("regular", { regular: 0, carryover: 0 }, limits)).toBe("regular");
        expect(slotFor("regular", { regular: 19, carryover: 0 }, limits)).toBe("regular");
        expect(slotFor("regular", { regular: 20, carryover: 0 }, limits)).toBeNull();
    });

    it("bài thường KHÔNG được dùng suất bù dù còn — suất bù chỉ dành cho bài tồn", () => {
        expect(slotFor("regular", { regular: 20, carryover: 0 }, limits)).toBeNull();
    });

    it("bài tồn dùng suất bù trước, kể cả khi suất thường còn", () => {
        expect(slotFor("carryover", { regular: 0, carryover: 0 }, limits)).toBe("carryover");
        expect(slotFor("carryover", { regular: 20, carryover: 4 }, limits)).toBe("carryover");
    });

    it("bài tồn hết suất bù thì rơi xuống suất thường, không bị chặn", () => {
        expect(slotFor("carryover", { regular: 3, carryover: 5 }, limits)).toBe("regular");
    });

    it("bài tồn hết cả hai loại suất -> chặn", () => {
        expect(slotFor("carryover", { regular: 20, carryover: 5 }, limits)).toBeNull();
    });

    it("CARRYOVER_EXTRA_POSTS_PER_DAY=0 -> bài tồn tính như bài thường", () => {
        const noExtra = { regular: 20, carryoverExtra: 0 };
        expect(slotFor("carryover", { regular: 0, carryover: 0 }, noExtra)).toBe("regular");
        expect(slotFor("carryover", { regular: 20, carryover: 0 }, noExtra)).toBeNull();
    });
});

describe("dailyQuota.isCarryoverJob", () => {
    const dayStart = new Date("2026-09-29T00:00:00+07:00");

    it("soạn trước 0h hôm nay (giờ VN) là bài tồn", () => {
        expect(isCarryoverJob(new Date("2026-09-28T23:59:00+07:00"), dayStart)).toBe(true);
        // 17:00 UTC ngày 28 = 0h ngày 29 giờ VN: đúng mốc thì KHÔNG còn là bài tồn.
        expect(isCarryoverJob(new Date("2026-09-28T17:00:00Z"), dayStart)).toBe(false);
    });

    it("soạn sau 0h hôm nay là bài của hôm nay", () => {
        expect(isCarryoverJob(new Date("2026-09-29T07:30:00+07:00"), dayStart)).toBe(false);
    });
});
