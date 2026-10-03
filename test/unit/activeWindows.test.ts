import { describe, expect, it } from "vitest";
import {
    addActiveMinutes,
    firstWindowStartOn,
    formatActiveWindows,
    isWithinWindows,
    nextWindowStart,
    parseActiveWindows,
} from "../../src/utils/activeWindows.js";

// Mọi mốc viết kèm +07:00 để test không phụ thuộc múi giờ của máy chạy.
const vn = (clock: string, day = "2026-09-17") => new Date(`${day}T${clock}:00+07:00`);
const windows = parseActiveWindows("18:00-22:30, 07:00-09:00,11:00-13:30");

describe("utils/activeWindows", () => {
    it("parse sắp xếp khung và định dạng lại đúng", () => {
        expect(formatActiveWindows(windows)).toBe("7h-9h, 11h-13h30, 18h-22h30");
        expect(parseActiveWindows("")).toEqual([]);
        expect(parseActiveWindows("00:00-24:00")).toEqual([{ startMinute: 0, endMinute: 1440 }]);
    });

    it("gõ sai thì ném lỗi chứ không lặng lẽ bỏ qua", () => {
        expect(() => parseActiveWindows("7h-9h")).toThrow();
        expect(() => parseActiveWindows("09:00-07:00")).toThrow();
        expect(() => parseActiveWindows("07:00-10:00,09:00-11:00")).toThrow();
        expect(() => parseActiveWindows("07:00-25:00")).toThrow();
    });

    it("ranh giới khung: đầu khung tính, cuối khung không tính", () => {
        expect(isWithinWindows(vn("07:00"), windows)).toBe(true);
        expect(isWithinWindows(vn("08:59"), windows)).toBe(true);
        expect(isWithinWindows(vn("09:00"), windows)).toBe(false);
        expect(isWithinWindows(vn("15:00"), windows)).toBe(false);
        expect(isWithinWindows(vn("22:29"), windows)).toBe(true);
        expect(isWithinWindows(vn("22:30"), windows)).toBe(false);
    });

    it("khung kế tiếp có thể ngay trong hôm nay, hết khung cuối thì sang sáng mai", () => {
        expect(nextWindowStart(vn("14:00"), windows)).toEqual(vn("18:00"));
        expect(nextWindowStart(vn("08:00"), windows)).toEqual(vn("11:00"));
        expect(nextWindowStart(vn("23:00"), windows)).toEqual(vn("07:00", "2026-09-18"));
        expect(firstWindowStartOn("2026-09-18", windows)).toEqual(vn("07:00", "2026-09-18"));
    });

    it("cộng phút chỉ đếm phút trong khung, nhảy qua giờ nghỉ", () => {
        expect(addActiveMinutes(vn("11:00"), 30, windows)).toEqual(vn("11:30"));
        // 13:00 + 60 phút: 30 phút trong khung trưa, 30 phút còn lại tính từ 18h.
        expect(addActiveMinutes(vn("13:00"), 60, windows)).toEqual(vn("18:30"));
        // Bắt đầu trong giờ nghỉ: mốc tính từ đầu khung kế tiếp, không bao giờ đúng phút mở khung.
        expect(addActiveMinutes(vn("15:00"), 25, windows)).toEqual(vn("18:25"));
        // Tràn qua khung cuối ngày -> sang khung sáng hôm sau.
        expect(addActiveMinutes(vn("22:00"), 45, windows)).toEqual(vn("07:15", "2026-09-18"));
    });

    it("mốc cộng dồn luôn nằm trong khung", () => {
        for (let offset = 0; offset < 2000; offset += 7) {
            expect(isWithinWindows(addActiveMinutes(vn("05:13"), offset, windows), windows)).toBe(true);
        }
    });
});
