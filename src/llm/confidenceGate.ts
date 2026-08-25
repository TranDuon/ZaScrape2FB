import { env } from "../config/env.js";
import type { ListingParsedData, ListingStatus } from "../models/listing.model.js";
import type { ExtractionResult } from "./extractor.schema.js";

/**
 * Các field được GHI NHẬN là thiếu, nhưng KHÔNG chặn tin đi tiếp.
 *
 * Trước đây thiếu bất kỳ field nào trong số này là đẩy sang `needs_review`. Thực tế dữ liệu Zalo
 * cho thấy quy tắc đó quá chặt: tin đăng thật (nhất là catalog nội bộ của môi giới) hiếm khi đủ cả
 * giá lẫn địa chỉ lẫn liên hệ trong cùng một tin, nên phần lớn tin thật bị chặn lại chờ duyệt tay —
 * đúng thứ mà việc tự động hoá sinh ra để tránh.
 *
 * Riêng `contact` còn vô nghĩa ngay từ đầu: `resolveContact()` trong composer.prompts.ts LUÔN ghi đè
 * bằng AGENT_CONTACT_NAME/AGENT_CONTACT_PHONE, vì người dùng đăng lại tin của người khác kèm số của
 * mình. Chặn tin vì thiếu một field sẽ bị vứt đi ở bước sau là chặn nhầm hoàn toàn.
 *
 * Vẫn tính và lưu vào `missing_required_fields` để hiện trong /status và soi lại khi cần —
 * chỉ là không dùng nó để chặn nữa.
 */
const TRACKED_FIELD_RULES: Array<{ field: string; satisfied: (data: ListingParsedData) => boolean }> = [
    {
        field: "price_vnd",
        satisfied: (data) => typeof data.price_vnd === "number" && data.price_vnd > 0,
    },
    {
        field: "address",
        satisfied: (data) => Boolean(data.address.raw || data.address.district),
    },
];

export interface GateDecision {
    status: Extract<ListingStatus, "ready" | "needs_review" | "ignored">;
    missingFields: string[];
    reason: string;
}

/**
 * Quyết định listing đi tiếp tự động hay dừng lại chờ người duyệt.
 *
 * Chỉ còn hai điều kiện chặn, theo đúng thứ tự:
 *   1. `is_listing` — không phải tin đăng phòng thì bỏ qua ngay, không xét gì thêm. Tin trò chuyện
 *      hay banner khuyến mãi thì không cần bận tâm nó thiếu giá hay thiếu địa chỉ.
 *   2. `confidence` — model tự nhận là không chắc thì để người xem lại. Đây là lớp bảo vệ duy nhất
 *      còn lại sau khi bỏ ràng buộc field, và cũng là lớp đúng chỗ: nó bắt được cả trường hợp tin
 *      gộp nhiều phòng (model trả confidence thấp) lẫn trường hợp bóc tách sai.
 */
export function evaluate(result: ExtractionResult, parsedData: ListingParsedData): GateDecision {
    if (!result.is_listing) {
        return {
            status: "ignored",
            missingFields: [],
            reason: result.is_listing_reason ?? "Không phải tin đăng phòng",
        };
    }

    const missingFields = TRACKED_FIELD_RULES.filter((rule) => !rule.satisfied(parsedData)).map((rule) => rule.field);

    if (result.confidence < env.CONFIDENCE_THRESHOLD) {
        return {
            status: "needs_review",
            missingFields,
            reason: `Độ tin cậy ${result.confidence.toFixed(2)} thấp hơn ngưỡng ${env.CONFIDENCE_THRESHOLD}`,
        };
    }

    const note =
        missingFields.length > 0
            ? `Là tin đăng phòng, độ tin cậy đạt ngưỡng (thiếu ${missingFields.join(", ")} nhưng vẫn cho đăng)`
            : "Đủ thông tin, độ tin cậy đạt ngưỡng";

    return { status: "ready", missingFields, reason: note };
}
