import { describe, expect, it } from "vitest";
import { normalizeForCompare } from "../../src/facebook/fbPoster.js";

/**
 * Phép so sánh nội dung này là cửa cuối trước khi bài ra công khai, nên nó phải sai theo đúng một
 * hướng: thà báo động thừa còn hơn bỏ lọt. Nhưng báo động thừa liên tục thì người vận hành sẽ tắt
 * nó đi — nên hai nhóm test dưới đây cân đúng hai phía đó.
 */
describe("normalizeForCompare", () => {
    // Chuỗi thật lấy từ post_jobs.payload.composed_text của bài đăng lúc 2026-08-24 10:08.
    const daDuyet = [
        "STUDIO NGÕ NGUYỄN AN NINH - HOÀNG MAI",
        "- Giá thuê: 5.300.000đ/tháng (Cọc 2 đóng 1)",
        "- Liên hệ xem phòng (báo trước 30p): Dương - 0862379005",
        "",
        "#chothuephongtro #studiohoangmai",
    ].join("\n");

    describe("phải BẮT được nội dung bị Facebook sửa", () => {
        it("bắt thẻ tag người chèn vào giữa bài, kèm mất dấu xuống dòng", () => {
            // Đúng những gì đã lên Facebook: "MAI" thành thẻ tag "Mai Anh", và dấu xuống dòng ngay
            // sau đó bị bảng gợi ý nuốt mất nên dòng 1 dính liền dòng 2.
            const thucTe = [
                "STUDIO NGÕ NGUYỄN AN NINH - HOÀNG Mai Anh- Giá thuê: 5.300.000đ/tháng (Cọc 2 đóng 1)",
                "- Liên hệ xem phòng (báo trước 30p): Dương - 0862379005",
                "",
                "#chothuephongtro #studiohoangmai",
            ].join("\n");

            expect(normalizeForCompare(thucTe)).not.toBe(normalizeForCompare(daDuyet));
        });

        it("bắt thẻ tag ngay cả khi không mất dấu xuống dòng", () => {
            const thucTe = daDuyet.replace("HOÀNG MAI", "HOÀNG Mai Anh");
            expect(normalizeForCompare(thucTe)).not.toBe(normalizeForCompare(daDuyet));
        });

        it("bắt mất dấu xuống dòng ngay cả khi không đổi ký tự nào", () => {
            const thucTe = daDuyet.replace("MAI\n- Giá", "MAI - Giá");
            expect(normalizeForCompare(thucTe)).not.toBe(normalizeForCompare(daDuyet));
        });

        it("bắt số điện thoại bị đổi — chữ số sai là thứ đắt nhất khi lọt", () => {
            const thucTe = daDuyet.replace("0862379005", "0862379006");
            expect(normalizeForCompare(thucTe)).not.toBe(normalizeForCompare(daDuyet));
        });
    });

    describe("phải BỎ QUA những khác biệt vô hại của trình soạn thảo", () => {
        it("bỏ qua dòng trống thừa ở cuối mà innerText luôn thêm vào", () => {
            expect(normalizeForCompare(daDuyet + "\n")).toBe(normalizeForCompare(daDuyet));
            expect(normalizeForCompare(daDuyet + "\n\n")).toBe(normalizeForCompare(daDuyet));
        });

        it("bỏ qua ký tự rộng-0 Facebook chèn để giữ con trỏ", () => {
            const coKyTuAn = daDuyet.replace("HOÀNG MAI", "HOÀNG​MAI﻿");
            expect(normalizeForCompare(coKyTuAn)).toBe(normalizeForCompare(daDuyet.replace("HOÀNG MAI", "HOÀNGMAI")));
        });

        it("coi khoảng trắng không ngắt như dấu cách thường", () => {
            const coNbsp = daDuyet.replace("Giá thuê", "Giá thuê");
            expect(normalizeForCompare(coNbsp)).toBe(normalizeForCompare(daDuyet));
        });

        it("bỏ qua khoảng trắng thừa ở đầu/cuối từng dòng", () => {
            const thuaCach = daDuyet
                .split("\n")
                .map((line) => `  ${line}  `)
                .join("\n");
            expect(normalizeForCompare(thuaCach)).toBe(normalizeForCompare(daDuyet));
        });

        it("coi CRLF như LF — không phụ thuộc hệ điều hành", () => {
            expect(normalizeForCompare(daDuyet.replace(/\n/g, "\r\n"))).toBe(normalizeForCompare(daDuyet));
        });
    });
});
