import type { ObjectId } from "mongodb";

export interface GroupDoc {
    _id?: ObjectId;
    name: string;
    url: string;
    fb_group_id: string | null;
    active: boolean;
    post_frequency: {
        max_posts_per_day: number;
        min_interval_minutes: number;
    };
    /**
     * Khu vực nhóm này phục vụ, khai báo tay (vd `["Cầu Giấy", "Nam Từ Liêm"]`).
     *
     * Để trống thì khu vực được suy ra từ chính `name`. Field này tồn tại vì tên nhóm là chuỗi
     * tự do do chủ nhóm đặt và đổi lúc nào cũng được — khi suy đoán từ tên sai, đây là đường
     * sửa mà không phải đụng vào code. Xem `src/facebook/areaMatcher.ts`.
     */
    areas?: string[] | null;
    last_posted_at: Date | null;
    posts_today_count: number;
    notes: string | null;
    created_at: Date;
    updated_at: Date;
}
