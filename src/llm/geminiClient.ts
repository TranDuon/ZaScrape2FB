import { GoogleGenAI, type Schema } from "@google/genai";
import { env } from "../config/env.js";
import { backoffDelay, sleep } from "../utils/delay.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("llm:gemini");

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Model dự phòng. BẮT BUỘC khác model chính, vì hạn ngạch gói miễn phí tính theo
 * `PerProjectPerModel` — đổi model là có hạn ngạch ngày riêng, không dùng chung.
 *
 * Trước đây đặt là `gemini-2.0-flash-lite`, nhưng model đó đã bị Google gỡ (trả 404), nghĩa là
 * đường dự phòng thực chất chưa bao giờ dùng được. Kiểm chứng ngày 21/08/2026 bằng lệnh gọi thật:
 * 2.0-flash, 2.0-flash-lite, 2.5-flash, 2.5-flash-lite đều 404; 3.5-flash, 3.5-flash-lite,
 * 3.1-flash-lite còn sống. Xem mục "Gemini model availability" trong CLAUDE.md.
 */
const FALLBACK_MODEL = "gemini-3.5-flash-lite";

/** Sau bao nhiêu lần 503 liên tiếp thì chuyển sang model dự phòng. */
const FALLBACK_AFTER_503_COUNT = 2;

/** Lỗi tạm thời: quá tải, sự cố phía server, chạm trần theo phút — thử lại có ích. */
const RETRYABLE_STATUS = [429, 500, 502, 503, 504];

/**
 * Model đã hết hạn ngạch NGÀY, kèm mốc được phép dùng lại.
 *
 * Nằm ở cấp module (sống xuyên suốt tiến trình) để lần gọi sau không phí thêm một lượt nữa vào
 * model đã biết chắc là hết. Không có nó thì mỗi job lại ăn thêm một lần 429 + chuỗi backoff.
 */
const exhaustedUntil = new Map<string, number>();

/**
 * 429 vì hết hạn ngạch NGÀY hay chỉ vì chạm trần theo phút?
 *
 * Phân biệt được là quan trọng: chạm trần theo phút thì đợi vài giây là qua, còn hết hạn ngạch
 * ngày thì thử lại bao nhiêu lần cũng vô ích cho tới nửa đêm — mà chuỗi backoff vẫn tốn tới cả
 * phút mỗi job rồi cuối cùng vẫn hỏng. Google ghi rõ trong `quotaId`, ví dụ
 * `GenerateRequestsPerDayPerProjectPerModel-FreeTier`.
 */
function isDailyQuotaError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /"quotaId"\s*:\s*"[^"]*PerDay[^"]*"/.test(message);
}

/**
 * 429 vì HẾT TIỀN trong tài khoản trả trước, không phải hết hạn ngạch.
 *
 * Đây là loại 429 thứ ba, và là loại vô vọng nhất: hạn ngạch ngày thì sang model khác vẫn chạy
 * được (mỗi model một hạn mức riêng), còn hết credit thì cả dự án dừng — đổi model không giúp
 * gì, chờ tới nửa đêm cũng không giúp gì, chỉ nạp tiền mới xong. Nếu không nhận ra loại này,
 * mã cũ coi nó là 429 tạm thời rồi đốt 5 lượt backoff trên model chính, đổi sang model dự
 * phòng, đốt tiếp 5 lượt nữa — mất khoảng hai phút mỗi job để đi tới đúng kết luận ban đầu.
 * Google không đặt `quotaId` cho lỗi này nên phải nhận dạng bằng chính câu thông báo.
 */
function isCreditsDepletedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /credits are depleted/i.test(message);
}

/**
 * Mốc hạn ngạch ngày được cấp lại: nửa đêm theo giờ Thái Bình Dương (Google reset theo mốc này),
 * không phải nửa đêm giờ Việt Nam.
 */
function nextQuotaResetMs(): number {
    const now = new Date();
    const pacificNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const pacificMidnight = new Date(pacificNow);
    pacificMidnight.setHours(24, 0, 0, 0);
    return now.getTime() + (pacificMidnight.getTime() - pacificNow.getTime());
}

function markExhausted(model: string): void {
    const until = nextQuotaResetMs();
    exhaustedUntil.set(model, until);
    log.error(
        { model, reset_at: new Date(until).toLocaleString("vi-VN", { timeZone: env.TZ }) },
        "Model đã HẾT HẠN NGẠCH NGÀY của gói miễn phí — chuyển sang model khác cho tới khi được cấp lại",
    );
}

function isExhausted(model: string): boolean {
    const until = exhaustedUntil.get(model);
    if (until === undefined) return false;
    if (Date.now() >= until) {
        exhaustedUntil.delete(model);
        return false;
    }
    return true;
}

let client: GoogleGenAI | null = null;

export function isGeminiConfigured(): boolean {
    return env.GEMINI_API_KEY.length > 0;
}

function getClient(): GoogleGenAI {
    if (!client) {
        if (!isGeminiConfigured()) {
            throw new Error("Thiếu GEMINI_API_KEY trong .env");
        }
        client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    }
    return client;
}

export interface ImagePart {
    mimeType: string;
    /** Dữ liệu ảnh đã mã hoá base64. */
    data: string;
}

/** Một mảnh nội dung gửi cho model: hoặc chữ, hoặc ảnh nhúng thẳng vào request. */
export type ContentPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GenerateJsonOptions {
    model: string;
    systemInstruction: string;
    /** Prompt dạng đơn giản: một khối chữ, ảnh (nếu có) nối vào sau. */
    prompt?: string;
    images?: ImagePart[];
    /**
     * Prompt dạng xen kẽ, dùng khi thứ tự chữ/ảnh mang ý nghĩa — ví dụ gom nhiều tin vào một
     * lần gọi, ảnh của tin nào phải nằm ngay sau phần chữ của tin đó. Đặt `parts` thì
     * `prompt`/`images` bị bỏ qua.
     */
    parts?: ContentPart[];
    responseSchema: Schema;
    /** Mặc định 0: cần kết quả ổn định, không cần sáng tạo khi trích xuất dữ liệu. */
    temperature?: number;
}

export interface GenerateJsonResult {
    raw: string;
    usage: { input_tokens: number | null; output_tokens: number | null };
    duration_ms: number;
}

function statusOf(error: unknown): number | null {
    if (typeof error !== "object" || error === null) return null;
    const candidate = error as { status?: unknown; code?: unknown };
    for (const value of [candidate.status, candidate.code]) {
        if (typeof value === "number") return value;
    }
    // SDK thường gói mã lỗi vào chuỗi message dạng "got status: 503 ...".
    const message = error instanceof Error ? error.message : "";
    const match = message.match(/\b(4\d{2}|5\d{2})\b/);
    return match ? Number(match[1]) : null;
}

/**
 * Gọi Gemini và trả về chuỗi JSON thô.
 *
 * Việc kiểm tra nội dung JSON có đúng schema hay không thuộc về nơi gọi (zod),
 * hàm này chỉ lo phần mạng: thử lại khi lỗi tạm thời, dừng ngay khi lỗi cấu hình
 * (sai API key, model không tồn tại) vì thử lại cũng vô ích.
 */
export async function generateJson(options: GenerateJsonOptions): Promise<GenerateJsonResult> {
    const parts: ContentPart[] = options.parts ?? [
        { text: options.prompt ?? "" },
        ...(options.images ?? []).map((image) => ({
            inlineData: { mimeType: image.mimeType, data: image.data },
        })),
    ];

    if (parts.length === 0) throw new Error("generateJson cần ít nhất một phần nội dung (prompt hoặc parts)");

    let lastError: unknown = null;
    let consecutive503 = 0;
    let activeModel = options.model;

    // Model chính đã hết hạn ngạch ngày từ lần gọi trước thì đi thẳng sang dự phòng,
    // khỏi phí thêm một lượt để nhận lại đúng lỗi 429 đó.
    if (isExhausted(activeModel) && !isExhausted(FALLBACK_MODEL) && activeModel !== FALLBACK_MODEL) {
        log.warn({ from: activeModel, to: FALLBACK_MODEL }, "Model chính đang hết hạn ngạch ngày, dùng model dự phòng");
        activeModel = FALLBACK_MODEL;
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const startedAt = Date.now();

        // Sau FALLBACK_AFTER_503_COUNT lần 503 liên tiếp → thử model dự phòng.
        // Chỉ chuyển khi model chính khác model dự phòng (tránh vòng lặp vô nghĩa).
        if (consecutive503 >= FALLBACK_AFTER_503_COUNT && activeModel !== FALLBACK_MODEL) {
            log.warn(
                { primary_model: options.model, fallback_model: FALLBACK_MODEL, attempt },
                "Model chính quá tải liên tục, chuyển sang model dự phòng",
            );
            activeModel = FALLBACK_MODEL;
            consecutive503 = 0; // reset để cho fallback thêm MAX_ATTEMPTS lần
        }

        try {
            const response = await getClient().models.generateContent({
                model: activeModel,
                contents: [{ role: "user", parts }],
                config: {
                    systemInstruction: options.systemInstruction,
                    responseMimeType: "application/json",
                    responseSchema: options.responseSchema,
                    temperature: options.temperature ?? 0,
                },
            });

            const raw = response.text;
            if (!raw || raw.trim().length === 0) {
                // Thường do model bị chặn bởi bộ lọc an toàn hoặc cụt output.
                throw new Error("Gemini trả về nội dung rỗng");
            }

            if (activeModel !== options.model) {
                log.info({ model_used: activeModel }, "Thành công với model dự phòng");
            }

            return {
                raw,
                usage: {
                    input_tokens: response.usageMetadata?.promptTokenCount ?? null,
                    output_tokens: response.usageMetadata?.candidatesTokenCount ?? null,
                },
                duration_ms: Date.now() - startedAt,
            };
        } catch (error) {
            lastError = error;
            const status = statusOf(error);

            // Hết credit: không có đường nào cứu được bằng cách thử lại. Dừng ngay để job hỏng
            // nhanh và người dùng thấy đúng nguyên nhân, thay vì chờ hai phút backoff vô nghĩa.
            if (status === 429 && isCreditsDepletedError(error)) {
                log.error(
                    { model: activeModel },
                    "Tài khoản Gemini đã HẾT CREDIT trả trước — nạp thêm tại https://ai.studio/projects. " +
                        "Đổi model hay thử lại đều không giải quyết được.",
                );
                break;
            }

            // Hết hạn ngạch NGÀY: thử lại cùng model là vô ích tới tận nửa đêm. Ghi nhận rồi
            // chuyển ngay sang model dự phòng (hạn ngạch tính riêng theo từng model).
            if (status === 429 && isDailyQuotaError(error)) {
                markExhausted(activeModel);

                if (activeModel !== FALLBACK_MODEL && !isExhausted(FALLBACK_MODEL)) {
                    activeModel = FALLBACK_MODEL;
                    consecutive503 = 0;
                    continue; // đổi model rồi thử luôn, không ngủ chờ
                }

                log.error({ model: activeModel }, "Mọi model đều hết hạn ngạch ngày — không còn đường nào để thử");
                break;
            }

            const retryable = status === null || RETRYABLE_STATUS.includes(status);

            if (status === 503) {
                consecutive503++;
            } else {
                consecutive503 = 0;
            }

            if (!retryable || attempt === MAX_ATTEMPTS) {
                log.error({ err: error, status, attempt, model: activeModel }, "Gọi Gemini thất bại");
                break;
            }

            const delay = backoffDelay(attempt, BASE_BACKOFF_MS, MAX_BACKOFF_MS);
            log.warn({ status, attempt, delay_ms: delay, model: activeModel }, "Gemini lỗi tạm thời, sẽ thử lại");
            await sleep(delay);
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
