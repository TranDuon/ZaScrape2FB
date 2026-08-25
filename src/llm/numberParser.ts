/**
 * Chuẩn hoá số tiền/diện tích do model trả về.
 *
 * Model được yêu cầu trả số, nhưng thực tế nó vẫn thỉnh thoảng trả chuỗi có định dạng
 * ("4.500.000", "4,5"). Cách viết số của người Việt ngược với tiếng Anh: dấu chấm là
 * phân cách hàng nghìn, dấu phẩy là phần thập phân. Parse nhầm hai dấu này làm giá thuê
 * lệch cả nghìn lần, nên cần xử lý tường minh thay vì tin vào Number().
 */
export function parseLooseNumber(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isFinite(value) && value > 0 ? value : null;
    }

    if (typeof value !== "string") return null;

    // Bỏ ký hiệu tiền tệ, đơn vị, khoảng trắng — chỉ giữ chữ số và dấu phân cách.
    const cleaned = value.replace(/[^\d.,]/g, "");
    if (cleaned.length === 0) return null;

    const lastDot = cleaned.lastIndexOf(".");
    const lastComma = cleaned.lastIndexOf(",");

    let normalized: string;

    if (lastDot >= 0 && lastComma >= 0) {
        // Có cả hai dấu: dấu xuất hiện SAU cùng là dấu thập phân, dấu kia là phân cách nghìn.
        const decimalSeparator = lastDot > lastComma ? "." : ",";
        const thousandSeparator = decimalSeparator === "." ? "," : ".";
        normalized = cleaned.split(thousandSeparator).join("").replace(decimalSeparator, ".");
    } else {
        const separator = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null;

        if (separator === null) {
            normalized = cleaned;
        } else {
            const parts = cleaned.split(separator);
            const tail = parts[parts.length - 1] ?? "";
            // Nhiều nhóm, hoặc nhóm cuối đúng 3 chữ số -> đây là phân cách hàng nghìn
            // ("4.500.000", "4.500"). Ngược lại coi là phần thập phân ("4,5" = 4.5 m2).
            const isThousandSeparator = parts.length > 2 || (parts.length === 2 && tail.length === 3);
            normalized = isThousandSeparator ? parts.join("") : parts.join(".");
        }
    }

    const result = Number(normalized);
    return Number.isFinite(result) && result > 0 ? result : null;
}
