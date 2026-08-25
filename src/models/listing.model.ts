import type { ObjectId } from "mongodb";

export const LISTING_STATUS = [
    "received",
    "extracting",
    "parsed",
    "needs_review",
    "ready",
    "queued",
    "posting",
    "posted",
    "failed",
    "rejected",
    "duplicate",
    "ignored",
    /** Quá hạn chưa đăng được — xem LISTING_MAX_AGE_DAYS và maintenance/listingExpiry.ts. */
    "expired",
] as const;

export type ListingStatus = (typeof LISTING_STATUS)[number];

export interface ListingImage {
    /** URL gốc từ CDN Zalo — chỉ để tham chiếu/debug, link sẽ hết hạn. */
    original_url: string | null;
    /** Đường dẫn file đã tải về, tương đối so với thư mục gốc dự án. */
    local_path: string | null;
    storage: "local" | "none";
    /** ID tin nhắn Zalo chứa ảnh này, phục vụ truy vết. */
    message_id: string | null;
    bytes: number | null;
    downloaded_at: Date | null;
    download_error: string | null;
}

export interface ListingAddress {
    raw: string | null;
    ward: string | null;
    district: string | null;
    city: string | null;
}

export interface ListingFurniture {
    summary: string | null;
    items: string[];
}

/**
 * Giá dịch vụ giữ nguyên dạng chuỗi gốc (ví dụ "35k/khối", "250k/người/tháng").
 * Ép sang số ở bước trích xuất rất dễ sai vì đơn vị trong tin nhắn không đồng nhất.
 */
export interface ListingUtilities {
    electricity_price: string | null;
    water_price: string | null;
    wifi_price: string | null;
    service_fee: string | null;
    service_fee_unit: "per_person" | "flat" | null;
}

export interface ListingHouseRules {
    deposit_terms: string | null;
    pet_allowed: boolean | null;
    vehicle_limit: string | null;
    foreigner_allowed: boolean | null;
    visit_notice_minutes: number | null;
    other_rules: string[];
}

export interface ListingParsedData {
    title: string | null;
    price_vnd: number | null;
    area_m2: number | null;
    address: ListingAddress;
    room_type: string | null;
    deposit_vnd: number | null;
    available_from: string | null;
    contact_phone: string | null;
    contact_name: string | null;
    furniture: ListingFurniture;
    utilities: ListingUtilities;
    house_rules: ListingHouseRules;
    amenities: string[];
    notes: string | null;
    extra: Record<string, unknown>;
}

export interface ListingStatusHistoryEntry {
    status: ListingStatus;
    at: Date;
    note: string | null;
}

export interface ListingDoc {
    _id?: ObjectId;
    source: {
        platform: "zalo";
        thread_id: string;
        /** 0 = chat cá nhân, 1 = group (khớp ThreadType của zca-js). */
        thread_type: number;
        sender_id: string;
        sender_name: string;
        /** Các tin nhắn được gộp thành listing này — cũng là khoá chống trùng. */
        message_ids: string[];
    };
    raw_message: {
        text: string;
        received_at: Date;
    };
    images: ListingImage[];
    is_listing: boolean | null;
    is_listing_reason: string | null;
    parsed_data: ListingParsedData | null;
    confidence_score: number | null;
    missing_required_fields: string[];
    extraction_meta: {
        model: string | null;
        prompt_version: string | null;
        attempts: number;
        last_error: string | null;
    };
    composed_post: {
        text: string | null;
        hashtags: string[];
        generated_at: Date | null;
        model: string | null;
        edited_by_user: boolean;
    } | null;
    status: ListingStatus;
    status_history: ListingStatusHistoryEntry[];
    review: {
        reviewed_at: Date | null;
        action: "approved" | "rejected" | "edited" | null;
    };
    target_group_ids: ObjectId[];
    created_at: Date;
    updated_at: Date;
}
