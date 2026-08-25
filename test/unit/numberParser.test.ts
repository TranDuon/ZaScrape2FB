import { describe, expect, it } from "vitest";
import { parseLooseNumber } from "../../src/llm/numberParser.js";

// Người Việt dùng dấu chấm cho hàng nghìn, dấu phẩy cho phần thập phân — ngược với tiếng Anh.
// Parse nhầm hai dấu này làm giá thuê lệch cả nghìn lần (bug thật đã gặp: "4.500.000" -> null).
describe("parseLooseNumber", () => {
    it.each([
        ["4.500.000", 4500000, "dấu chấm là phân cách hàng nghìn"],
        ["4.500", 4500, "nhóm cuối 3 chữ số -> hàng nghìn, không phải 4.5"],
        ["4,5", 4.5, "dấu phẩy là phần thập phân"],
        ["25,5", 25.5, "diện tích lẻ"],
        ["1.234.567,89", 1234567.89, "có cả hai dấu"],
        ["4500000 đ", 4500000, "bỏ được đơn vị tiền"],
        [4500000, 4500000, "số nguyên giữ nguyên"],
        ["", null, "chuỗi rỗng -> null"],
        ["liên hệ", null, "chữ thuần -> null"],
        [0, null, "số 0 coi như không có giá"],
        [null, null, "null -> null"],
    ] as const)("%s -> %s (%s)", (input, expected, _label) => {
        expect(parseLooseNumber(input)).toBe(expected);
    });
});
