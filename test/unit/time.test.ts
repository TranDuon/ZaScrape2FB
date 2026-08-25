import { describe, expect, it } from "vitest";
import { businessDateKey, businessHour } from "../../src/utils/time.js";

describe("utils/time (giờ Asia/Ho_Chi_Minh)", () => {
    // 18:30 UTC 17/08 = 01:30 ngày 18/08 giờ VN — nếu tính theo toISOString() sẽ ra
    // sai ngày (17/08), đúng lý do timezone.ts tồn tại.
    const utcLateEvening = new Date("2026-08-17T18:30:00Z");

    it("khoá ngày lấy đúng ngày giờ VN, không phải ngày UTC", () => {
        expect(businessDateKey(utcLateEvening)).toBe("2026-08-18");
    });

    it("giờ trong ngày tính theo giờ VN", () => {
        expect(businessHour(utcLateEvening)).toBe(1);
    });
});
