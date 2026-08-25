import "dotenv/config";
import { z } from "zod";

/**
 * Chuỗi CSV dạng `khoa:so` -> Map. Phần tử sai định dạng bị bỏ qua thay vì làm chết cả tiến trình:
 * một dòng .env gõ nhầm không đáng để agent không khởi động được, và nhóm gõ sai chỉ đơn giản rơi
 * về hạn mức mặc định — thấy ngay trong log vì log luôn in `limit` thực tế đang áp dụng.
 */
const csvNumberMap = z
    .string()
    .optional()
    .transform((raw) => {
        const map = new Map<string, number>();

        for (const entry of (raw ?? "").split(",")) {
            const [key, value] = entry.split(":").map((part) => part.trim());
            const parsed = Number(value);

            if (!key || !Number.isInteger(parsed) || parsed < 0) continue;
            map.set(key, parsed);
        }

        return map;
    });

/** Chuỗi CSV -> mảng đã trim, bỏ phần tử rỗng. Dùng cho các allowlist. */
const csvList = z
    .string()
    .optional()
    .transform((raw) =>
        (raw ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0),
    );

const envSchema = z.object({
    MONGODB_URI: z.string().min(1, "MONGODB_URI là bắt buộc"),
    MONGODB_DB_NAME: z.string().default("sale_room_agent"),

    // Mọi tính toán ngày/giờ đi qua utils/time.ts và dùng đúng timezone này,
    // không bao giờ dựa vào giờ hệ thống của VPS (thường là UTC).
    TZ: z.string().default("Asia/Ho_Chi_Minh"),

    ZALO_SESSION_DIR: z.string().default("./data/zalo-session"),
    ZALO_IMAGE_DIR: z.string().default("./data/images"),
    ZALO_ALLOWED_THREAD_IDS: csvList,
    ZALO_ALLOWED_SENDER_IDS: csvList,
    ZALO_BATCH_WINDOW_MS: z.coerce.number().int().positive().default(45_000),
    ZALO_BATCH_MAX_MS: z.coerce.number().int().positive().default(300_000),
    // Trần số tin nhận MỖI NGÀY MỖI NHÓM Zalo. Lọc ngay ở khâu thu, TRƯỚC khi tốn bất kỳ đồng
    // Gemini nào: 3 nhóm dội về 50-100 phòng/ngày trong khi cả ngày chỉ đăng được ~15 bài, nên
    // trích xuất hết là trả tiền cho dữ liệu chắc chắn không dùng tới.
    // Đây KHÔNG phải mất dữ liệu do lỗi mà là hạn mức cố ý — xem messageListener.persistBatch.
    MAX_LISTINGS_PER_THREAD_PER_DAY: z.coerce.number().int().positive().default(5),
    // Trần riêng cho từng nhóm, dạng `threadId:so,threadId:so`. Nhóm không khai ở đây dùng
    // MAX_LISTINGS_PER_THREAD_PER_DAY ở trên.
    //
    // Có mặt vì mật độ tin giữa các nhóm rất lệch nhau: chia đều 15 suất cho 3 nhóm nghĩa là nhóm
    // đông tin bị cắt mất phần lớn phòng tốt, trong khi nhóm thưa tin không bao giờ dùng hết phần
    // của nó — suất bỏ phí đó không được nhóm nào khác nhặt lại vì trần tính theo từng nhóm.
    // TỔNG các trần nên bằng MAX_POSTS_PER_DAY / MAX_GROUPS_PER_LISTING, xem chuỗi hạn mức trong
    // CLAUDE.md; đặt tổng cao hơn chỉ tạo ra tồn kho hết hạn sau LISTING_MAX_AGE_DAYS ngày.
    LISTINGS_PER_THREAD_OVERRIDES: csvNumberMap,
    ZALO_RECONNECT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    ZALO_RECONNECT_MAX_BACKOFF_MS: z.coerce.number().int().positive().default(300_000),

    // GEMINI_API_KEY để rỗng vẫn khởi động được: listener Zalo phải chạy tiếp
    // dù chưa cấu hình LLM. Worker trích xuất sẽ tự tắt và báo rõ lý do.
    GEMINI_API_KEY: z.string().default(""),
    GEMINI_EXTRACTION_MODEL: z.string().default("gemini-3.5-flash"),
    MAX_IMAGES_PER_EXTRACTION: z.coerce.number().int().min(0).max(16).default(4),
    EXTRACTION_IMAGE_MAX_DIMENSION: z.coerce.number().int().positive().default(1024),
    CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),

    // Hạn ngạch gói miễn phí tính theo SỐ LẦN GỌI mỗi ngày mỗi model, không theo token —
    // nên gom N tin vào một lần gọi nhân capacity lên đúng N lần. Đây là lý do tồn tại của
    // ba biến dưới; xem mục "Gộp lô lời gọi Gemini" trong CLAUDE.md.
    //
    // Cửa sổ chờ gom lô: worker giữ job đã nhận lại chờ thêm job mới trong khoảng này rồi mới
    // gọi Gemini một lần cho cả lô. Đặt 0 để tắt hẳn việc chờ (vẫn gom nếu hàng đợi sẵn có).
    LLM_BATCH_WINDOW_MS: z.coerce.number().int().min(0).default(300_000),
    // Số tin tối đa trong một lần gọi trích xuất. Đủ job là chạy ngay, không chờ hết cửa sổ.
    EXTRACTION_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(5),
    // Trần TỔNG số ảnh của cả lô. Ảnh được chia đều cho các tin trong lô, nên lô càng đông thì
    // mỗi tin càng ít ảnh — giữ kích thước request trong tầm kiểm soát.
    EXTRACTION_BATCH_MAX_IMAGES: z.coerce.number().int().min(1).max(64).default(16),

    GEMINI_COMPOSER_MODEL: z.string().default("gemini-3.5-flash"),
    // Thấp hơn lô trích xuất vì mỗi phòng sinh ra nhiều biến thể: số bài phải viết trong một
    // lần gọi là COMPOSE_BATCH_SIZE × số group. Lô quá lớn dễ bị cắt cụt output -> hỏng JSON.
    COMPOSE_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(3),
    // Số biến thể nội dung tối đa sinh trong MỘT lần gọi. Nhiều group hơn số này thì
    // dùng lại biến thể theo vòng, đổi lấy chi phí thấp hơn.
    POST_VARIATION_COUNT: z.coerce.number().int().min(1).max(10).default(5),
    // Giãn cách ngẫu nhiên giữa các group, cộng dồn: group sau luôn muộn hơn group trước.
    COMPOSE_STAGGER_MIN_MINUTES: z.coerce.number().int().positive().default(5),
    COMPOSE_STAGGER_MAX_MINUTES: z.coerce.number().int().positive().default(20),

    // Thong tin lien he hien thi tren bai dang Facebook (override thong tin nguoi bao phong).
    AGENT_CONTACT_NAME: z.string().default(""),
    AGENT_CONTACT_PHONE: z.string().default(""),

    FB_BROWSER_PROFILE_DIR: z.string().default("./data/fb-browser-profile"),
    // Trên VPS bắt buộc true (không có màn hình). Ở máy dev nên để false lúc đầu
    // để nhìn tận mắt agent thao tác gì trên Facebook.
    FB_HEADLESS: z
        .string()
        .default("true")
        .transform((value) => value === "true" || value === "1"),
    FB_SCREENSHOT_DIR: z.string().default("./data/fb-screenshots"),
    FB_ACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    // Mặc định CỐ Ý thấp. Tài khoản Facebook mới gần như không có điểm tin cậy,
    // đăng nhiều bài mỗi ngày là cách nhanh nhất để bị checkpoint. Chỉ nên tăng dần
    // sau vài tuần chạy êm.
    MAX_POSTS_PER_DAY: z.coerce.number().int().positive().default(3),
    GROUP_MIN_INTERVAL_MINUTES: z.coerce.number().int().positive().default(180),

    // Số nhóm tối đa MỘT tin được đăng lên. Ba lý do, lý do thứ ba là ràng buộc dễ quên nhất:
    // - Một tin khớp 10 nhóm mà đăng cả 10 thì ăn hết nửa hạn mức ngày cho đúng một phòng.
    // - Cùng với MAX_POSTS_PER_DAY, biến này quyết định luôn số tin được soạn mỗi ngày
    //   (= MAX_POSTS_PER_DAY / MAX_GROUPS_PER_LISTING) — xem `dailyComposeBudget` ở composerWorker.
    // - NÊN GIỮ <= POST_VARIATION_COUNT. `assignVariations` chia biến thể theo vòng
    //   (`shuffled[index % length]`), nên số nhóm vượt số biến thể là có nhóm nhận lại NGUYÊN VĂN
    //   bài của nhóm khác — chính là dấu hiệu đăng spam chéo nhóm mà Facebook dò tìm.
    MAX_GROUPS_PER_LISTING: z.coerce.number().int().positive().default(3),

    // Khung giờ được phép đăng, theo giờ VN. Đăng đều đặn lúc 3h sáng là dấu hiệu
    // bot rõ hơn cả tần suất, nên ngoài khung này job bị dời sang hôm sau.
    ACTIVE_HOURS_START: z.coerce.number().int().min(0).max(23).default(8),
    ACTIVE_HOURS_END: z.coerce.number().int().min(1).max(24).default(22),
    ACTIVE_HOURS_JITTER_MINUTES: z.coerce.number().int().min(0).default(30),

    // Khoảng nghỉ giả lập người thật giữa các thao tác trong trình duyệt.
    HUMAN_DELAY_MIN_MS: z.coerce.number().int().positive().default(600),
    HUMAN_DELAY_MAX_MS: z.coerce.number().int().positive().default(2_500),

    // Để rỗng thì agent vẫn chạy, chỉ mất kênh thông báo (ghi log thay thế).
    TELEGRAM_BOT_TOKEN: z.string().default(""),
    // Chỉ chat ID này được ra lệnh cho bot. Ai biết token mà không đúng chat ID
    // thì lệnh vẫn bị bỏ qua.
    TELEGRAM_CHAT_ID: z.string().default(""),

    // Mỗi nhịp chỉ xử lý đúng một job đăng bài, nên nhịp này cũng là khoảng cách
    // tối thiểu giữa hai bài.
    SCHEDULER_TICK_CRON: z.string().default("*/2 * * * *"),
    HEALTH_CHECK_PORT: z.coerce.number().int().positive().default(3100),
    // Chỉ nghe localhost: /health lộ toàn bộ tình trạng vận hành, không nên hở ra internet.
    HEALTH_CHECK_BIND: z.string().default("127.0.0.1"),

    // Tin chưa đăng được quá số ngày này thì hết hạn: phòng trọ mất giá rất nhanh, đăng một
    // phòng của 3 ngày trước thì phần lớn đã cho thuê xong — vừa phí một suất đăng trong ngày,
    // vừa làm người đọc mất tin tưởng. Cũng là thứ chặn hàng đợi phình vô hạn khi lượng tin về
    // nhiều hơn lượng đăng được.
    LISTING_MAX_AGE_DAYS: z.coerce.number().int().positive().default(2),

    JOB_HISTORY_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
    // Ảnh của tin đăng đã ở trạng thái chung cuộc (posted/ignored/rejected) và đủ cũ thì bị xoá
    // khỏi đĩa — ảnh KHÔNG nằm trong MongoDB nên không có TTL index nào tự lo việc này.
    IMAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    // Cảnh báo qua Telegram khi ổ đĩa vượt ngưỡng này (%). Kiểm tra mỗi giờ, không phải mỗi tick.
    DISK_USAGE_WARN_PERCENT: z.coerce.number().min(1).max(100).default(85),

    // Nơi cất bản sao phiên đăng nhập Zalo/Facebook. Mất phiên = phải đăng nhập tay lại, mà
    // riêng Facebook đăng nhập lại từ IP mới rất dễ dính checkpoint — nên đây là dữ liệu quan
    // trọng nhất trên đĩa, hơn cả ảnh.
    SESSION_BACKUP_DIR: z.string().default("./data/session-backups"),
    SESSION_BACKUP_KEEP: z.coerce.number().int().positive().default(5),

    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    LOG_PRETTY: z
        .string()
        .default("false")
        .transform((value) => value === "true" || value === "1"),
    LOG_DIR: z.string().default("./logs"),
    // Log xoay vòng theo ngày qua pino-roll, giữ N file gần nhất rồi tự xoá — tránh logs/
    // đầy disk sau vài tuần chạy liên tục trên VPS. Cùng mặc định 7 ngày như post_jobs/post_history
    // cho dễ nhớ, nhưng là biến độc lập vì hai thứ không liên quan.
    LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    // Fail fast: thiếu config thì dừng ngay lúc khởi động, không để chạy nửa vời rồi lỗi giữa chừng.
    throw new Error(`Cấu hình .env không hợp lệ:\n${details}`);
}

export const env = parsed.data;

if (env.ZALO_BATCH_MAX_MS < env.ZALO_BATCH_WINDOW_MS) {
    throw new Error("ZALO_BATCH_MAX_MS phải >= ZALO_BATCH_WINDOW_MS");
}

if (env.COMPOSE_STAGGER_MAX_MINUTES < env.COMPOSE_STAGGER_MIN_MINUTES) {
    throw new Error("COMPOSE_STAGGER_MAX_MINUTES phải >= COMPOSE_STAGGER_MIN_MINUTES");
}

if (env.ACTIVE_HOURS_END <= env.ACTIVE_HOURS_START) {
    throw new Error("ACTIVE_HOURS_END phải lớn hơn ACTIVE_HOURS_START");
}

if (env.HUMAN_DELAY_MAX_MS < env.HUMAN_DELAY_MIN_MS) {
    throw new Error("HUMAN_DELAY_MAX_MS phải >= HUMAN_DELAY_MIN_MS");
}
