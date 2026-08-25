import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import type { ListingDoc } from "../models/listing.model.js";
import { generateJson } from "./geminiClient.js";
import {
    COMPOSER_PROMPT_VERSION,
    COMPOSER_RESPONSE_SCHEMA,
    COMPOSER_SYSTEM_INSTRUCTION,
    buildComposerPrompt,
    composerSchema,
    type ComposerItem,
} from "./composer.prompts.js";

const log = childLogger("llm:composer");

export interface PostVariation {
    text: string;
    hashtags: string[];
    /** Nội dung hoàn chỉnh sẽ dán vào ô soạn bài Facebook. */
    fullText: string;
}

export interface ComposeOutcome {
    variations: PostVariation[];
    model: string;
    promptVersion: string;
    durationMs: number;
    /** Token của CẢ LẦN GỌI — đọc kèm `batchSize`, xem chú thích ở ExtractionOutcome. */
    usage: { input_tokens: number | null; output_tokens: number | null };
    /** Số phòng dùng chung lần gọi này. */
    batchSize: number;
}

function assemble(text: string, hashtags: string[]): string {
    const body = text.trim();
    if (hashtags.length === 0) return body;
    return `${body}\n\n${hashtags.join(" ")}`;
}

/** Kết quả cho MỘT phòng trong lô — lỗi của một phòng không làm hỏng các phòng còn lại. */
export type ComposeItemOutcome = { ok: true; outcome: ComposeOutcome } | { ok: false; error: Error };

/**
 * Soạn bài cho NHIỀU phòng trong MỘT lần gọi Gemini, mỗi phòng nhiều biến thể.
 *
 * Gộp ở hai tầng, vì hai lý do khác nhau:
 * - Nhiều biến thể trong một lần gọi: model nhìn thấy các biến thể khác cùng lúc nên chủ động
 *   viết khác nhau — gọi riêng lẻ với cùng một prompt thường cho ra các bài na ná nhau.
 * - Nhiều phòng trong một lần gọi: hạn ngạch miễn phí đếm theo SỐ LẦN GỌI mỗi ngày mỗi model.
 *
 * Số bài phải viết trong một lần gọi là `batch.length × variationCount`, và đây là chỗ dễ chạm
 * trần output nhất trong cả dự án — nên COMPOSE_BATCH_SIZE mặc định thấp hơn lô trích xuất.
 *
 * Trả về mảng CÙNG ĐỘ DÀI, CÙNG THỨ TỰ với `batch`. Ném lỗi chỉ khi cả lần gọi hỏng.
 */
export async function composePosts(
    batch: ListingDoc[],
    variationCounts: number[],
): Promise<ComposeItemOutcome[]> {
    if (batch.length === 0) return [];

    const missingData = batch.find((listing) => !listing.parsed_data);
    if (missingData) {
        throw new Error("Listing chưa có parsed_data — phải chạy trích xuất trước khi soạn bài");
    }

    // Số biến thể tính RIÊNG cho từng phòng (= số nhóm phòng đó sẽ được đăng lên). Trước đây cả
    // lô dùng chung con số lớn nhất, nên phòng chỉ khớp 1 nhóm vẫn bị viết đủ 3 bài khi đi chung
    // lô với phòng khớp 3 nhóm — output là phần đắt nhất của bước soạn bài nên đó là phí thật.
    const counts = batch.map((_, index) =>
        Math.max(1, Math.min(variationCounts[index] ?? 1, env.POST_VARIATION_COUNT)),
    );

    const items: ComposerItem[] = batch.map((listing, index) => ({
        data: listing.parsed_data as NonNullable<ListingDoc["parsed_data"]>,
        imageCount: listing.images.length,
        variationCount: counts[index] as number,
    }));

    const response = await generateJson({
        model: env.GEMINI_COMPOSER_MODEL,
        systemInstruction: COMPOSER_SYSTEM_INSTRUCTION,
        prompt: buildComposerPrompt(items),
        responseSchema: COMPOSER_RESPONSE_SCHEMA,
        // Cần đa dạng giữa các biến thể, nên KHÔNG dùng temperature 0 như bước trích xuất.
        temperature: 1,
    });

    let payload: unknown;
    try {
        payload = JSON.parse(response.raw);
    } catch {
        // Lô lớn + nhiều biến thể là nguyên nhân số một: output bị cắt cụt giữa chừng thì JSON
        // không đóng ngoặc. Ghi rõ để người vận hành biết chỉnh biến nào thay vì mò.
        log.error(
            { raw: response.raw.slice(0, 500), batch_size: batch.length, variations: counts, output_length: response.raw.length },
            "Composer trả về JSON không hợp lệ — nếu tái diễn thì giảm COMPOSE_BATCH_SIZE hoặc POST_VARIATION_COUNT",
        );
        throw new Error("Composer trả về JSON không hợp lệ");
    }

    const parsed = composerSchema.safeParse(payload);
    if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        throw new Error(`Kết quả composer không khớp schema: ${detail}`);
    }

    // Ghép theo `index` chứ không theo vị trí: gán nhầm ở đây là đăng lên Facebook bài mang địa
    // chỉ phòng này kèm giá và số điện thoại của phòng khác.
    const byIndex = new Map<number, (typeof parsed.data.items)[number]>();
    for (const item of parsed.data.items) {
        if (item.index < 1 || item.index > batch.length) continue;
        if (byIndex.has(item.index)) continue;
        byIndex.set(item.index, item);
    }

    if (byIndex.size < batch.length) {
        log.warn(
            { batch_size: batch.length, received: byIndex.size, returned: parsed.data.items.length },
            "Model bỏ sót phòng trong lô — những phòng thiếu sẽ được thử lại riêng",
        );
    }

    return batch.map((_, position) => {
        const item = byIndex.get(position + 1);

        if (!item) {
            return {
                ok: false as const,
                error: new Error(`Model không trả bài cho phòng #${position + 1} trong lô ${batch.length} phòng`),
            };
        }

        const variations = item.variations.map((variation) => ({
            text: variation.text.trim(),
            hashtags: variation.hashtags,
            fullText: assemble(variation.text, variation.hashtags),
        }));

        if (variations.length < (counts[position] as number)) {
            // Không coi là lỗi: ít biến thể hơn mong muốn thì phân bổ vòng lại, vẫn đăng được.
            log.warn(
                { position: position + 1, requested: counts[position], received: variations.length },
                "Model trả về ít biến thể hơn yêu cầu",
            );
        }

        return {
            ok: true as const,
            outcome: {
                variations,
                model: env.GEMINI_COMPOSER_MODEL,
                promptVersion: COMPOSER_PROMPT_VERSION,
                durationMs: response.duration_ms,
                usage: response.usage,
                batchSize: batch.length,
            },
        };
    });
}

/** Soạn bài cho một phòng đơn lẻ — lô một phần tử, đi đúng đường code của lô nhiều phần tử. */
export async function composePost(listing: ListingDoc, variationCount: number): Promise<ComposeOutcome> {
    const [item] = await composePosts([listing], [variationCount]);

    if (!item) throw new Error("Composer không trả về kết quả nào");
    if (!item.ok) throw item.error;

    return item.outcome;
}
