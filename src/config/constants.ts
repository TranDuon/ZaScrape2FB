/** Tên collection tập trung một chỗ, tránh gõ chuỗi rải rác khắp code. */
export const COLLECTIONS = {
    listings: "listings",
    groups: "groups",
    postJobs: "post_jobs",
    postHistory: "post_history",
    appState: "app_state",
    dailyMetrics: "daily_metrics",
} as const;

/** `app_state` là document singleton duy nhất. */
export const APP_STATE_ID = "singleton";

/** Timezone nghiệp vụ — mọi khoá ngày (`daily_counters.date`, `daily_metrics._id`) theo giờ VN. */
export const BUSINESS_TIMEZONE = "Asia/Ho_Chi_Minh";

export const SECONDS_PER_DAY = 86_400;
