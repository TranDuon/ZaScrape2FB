import { Bot, isTransientError, type Context } from "node-telegram-bot-api";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("telegram");

/** Telegram từ chối tin nhắn dài hơn mức này. */
const MAX_MESSAGE_LENGTH = 4_096;

/**
 * Số lần gửi lại khi gặp lỗi tạm thời, và khoảng chờ giữa các lần (tăng dần).
 *
 * api.telegram.org bị ISP Việt Nam bóp không đều, timeout vài giây rồi lại thông là chuyện thường.
 * Vòng lặp nhận lệnh đã tự thử lại vô hạn, nhưng chiều GỬI ĐI thì trước đây bắt lỗi rồi bỏ luôn —
 * một lần chớp mạng là mất trắng thông báo. Nguy hiểm nhất với `notifyNeedsReview`: tin nằm chờ
 * duyệt mãi mà người dùng không hề biết có gì để duyệt.
 */
const SEND_MAX_ATTEMPTS = 4;
const SEND_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

export type CommandHandler = (args: string[]) => Promise<string> | string;
export type CallbackHandler = (action: string, payload: string) => Promise<string> | string;

export interface InlineButton {
    text: string;
    callback_data: string;
}

let bot: Bot | null = null;
let polling: Promise<void> | null = null;
let pollingAlive = false;

/**
 * Vòng lặp nhận lệnh Telegram còn sống không.
 *
 * Cần thiết vì bot chết là mất TOÀN BỘ kênh điều khiển, mà không thể báo tin đó qua chính
 * Telegram được. `/health` và `npm run check:stuck` đọc cờ này để báo bằng kênh khác.
 */
export function isPollingAlive(): boolean {
    return pollingAlive;
}

const commands = new Map<string, CommandHandler>();
let callbackHandler: CallbackHandler | null = null;

export function isTelegramConfigured(): boolean {
    return env.TELEGRAM_BOT_TOKEN.length > 0 && env.TELEGRAM_CHAT_ID.length > 0;
}

/**
 * Chỉ chấp nhận lệnh từ đúng chat ID đã cấu hình.
 *
 * Bot token nằm trong .env, nhưng nếu lộ ra ngoài thì bất kỳ ai cũng nhắn được cho bot.
 * Kiểm tra chat ID là lớp chặn duy nhất giữa người lạ và các lệnh như /resume hay /approve.
 */
function isAuthorized(chatId: number | undefined): boolean {
    return chatId !== undefined && String(chatId) === env.TELEGRAM_CHAT_ID;
}

function splitLongMessage(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= MAX_MESSAGE_LENGTH) {
            chunks.push(remaining);
            break;
        }

        // Cắt ở chỗ xuống dòng gần nhất để không đứt giữa câu.
        const slice = remaining.slice(0, MAX_MESSAGE_LENGTH);
        const breakAt = slice.lastIndexOf("\n");
        const cutAt = breakAt > MAX_MESSAGE_LENGTH / 2 ? breakAt : MAX_MESSAGE_LENGTH;

        chunks.push(remaining.slice(0, cutAt));
        remaining = remaining.slice(cutAt).trimStart();
    }

    return chunks;
}

export function registerCommand(name: string, handler: CommandHandler): void {
    commands.set(name.toLowerCase(), handler);
}

export function registerCallbackHandler(handler: CallbackHandler): void {
    callbackHandler = handler;
}

/**
 * Gửi một mảnh tin, thử lại khi gặp lỗi tạm thời.
 *
 * Dùng `isTransientError` của chính thư viện để phân loại, đúng tiêu chí mà vòng lặp nhận lệnh
 * đang dùng (mất mạng, timeout, 429, 5xx). Lỗi KHÔNG tạm thời (chat_id sai, tin quá dài, token
 * hỏng) thì thử lại cũng vô ích — ném ra ngay để nơi gọi ghi log.
 */
async function sendChunkWithRetry(payload: Parameters<Bot["api"]["sendMessage"]>[0]): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await bot!.api.sendMessage(payload);
            if (attempt > 1) log.info({ attempt }, "Gửi lại thông báo Telegram thành công");
            return;
        } catch (error) {
            if (!isTransientError(error) || attempt >= SEND_MAX_ATTEMPTS) throw error;

            const wait = SEND_RETRY_DELAYS_MS[attempt - 1] ?? 8_000;
            log.warn({ attempt, wait_ms: wait }, "Lỗi tạm thời khi gửi thông báo Telegram, sẽ thử lại");
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
    }
}

/**
 * Gửi thông báo cho người dùng.
 *
 * Không bao giờ ném lỗi ra ngoài: Telegram chết không được phép làm hỏng việc đăng bài
 * hay xử lý tin nhắn Zalo. Hết lượt thử lại thì ghi log rồi đi tiếp.
 */
export async function sendNotification(text: string, options?: { keyboard?: InlineButton[][] }): Promise<void> {
    if (!bot || !isTelegramConfigured()) {
        log.info({ notification: text }, "Telegram chưa cấu hình — chỉ ghi log");
        return;
    }

    try {
        const chunks = splitLongMessage(text);

        for (const [index, chunk] of chunks.entries()) {
            const isLast = index === chunks.length - 1;

            await sendChunkWithRetry({
                chat_id: env.TELEGRAM_CHAT_ID,
                text: chunk,
                // Bàn phím chỉ gắn vào mảnh cuối, nếu không sẽ hiện lặp lại nhiều lần.
                ...(isLast && options?.keyboard ? { reply_markup: { inline_keyboard: options.keyboard } } : {}),
            });
        }
    } catch (error) {
        // Tới đây là đã thử lại hết lượt mà vẫn không gửi được. Ghi ở mức error kèm nội dung
        // để còn đọc lại được trong log — thông báo đã mất, không có nơi nào khác giữ nó.
        log.error({ err: error, notification: text.slice(0, 200) }, "Gửi thông báo Telegram thất bại hẳn");
    }
}

/** `ctx.match` chứa phần đứng sau tên lệnh, ví dụ "/edit abc price=100" -> "abc price=100". */
function argsOf(ctx: Context): string[] {
    const raw = typeof ctx.match === "string" ? ctx.match : "";
    return raw.split(/\s+/).filter(Boolean);
}

export function startTelegramBot(): void {
    if (!isTelegramConfigured()) {
        log.warn("Chưa cấu hình TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID — thông báo chỉ ghi ra log");
        return;
    }

    bot = new Bot(env.TELEGRAM_BOT_TOKEN);

    for (const [name, handler] of commands) {
        bot.command(name, async (ctx) => {
            if (!isAuthorized(ctx.chatId)) {
                log.warn({ chat_id: ctx.chatId }, "Bỏ qua lệnh từ chat lạ");
                return;
            }

            const reply = await handler(argsOf(ctx));
            if (reply) await ctx.reply(reply);
        });
    }

    bot.on("callback_query", async (ctx) => {
        if (!isAuthorized(ctx.chatId)) return;

        // Trả lời ngay để Telegram tắt vòng xoay trên nút bấm.
        await ctx.answerCallbackQuery().catch(() => undefined);

        const [action, payload] = (ctx.callbackQuery?.data ?? "").split(":");
        if (!action || !callbackHandler) return;

        const reply = await callbackHandler(action, payload ?? "");
        if (reply) await ctx.reply(reply);
    });

    // Lỗi trong một handler không được phép làm chết vòng lặp nhận tin.
    bot.catch((error, ctx) => {
        log.error({ err: error, chat_id: ctx.chatId }, "Lỗi khi xử lý cập nhật Telegram");
    });

    // Long polling: không cần URL công khai hay reverse proxy, chạy được sau NAT.
    // Thư viện tự thử lại vô hạn với lỗi tạm thời (mất mạng, timeout, 429, 5xx) và KHÔNG
    // advance offset nên không mất tin nhắn — mạng chập chờn là chuyện bình thường, không đáng lo.
    pollingAlive = true;
    polling = bot.startPolling(undefined, {
        onError: (error) => log.warn({ err: error }, "Lỗi tạm thời khi nhận tin Telegram, sẽ thử lại"),
    });

    polling.catch((error) => {
        // Tới được đây nghĩa là lỗi KHÔNG tạm thời (token sai/bị thu hồi, bot bị xoá...) và
        // vòng lặp đã chết hẳn, không tự hồi phục. Toàn bộ lệnh điều khiển ngừng hoạt động —
        // nghiêm trọng nhất là /resume, cách duy nhất mở lại cầu dao Facebook qua Telegram.
        // Không thể báo qua Telegram (kênh vừa chết), nên hạ cờ để /health và check:stuck thấy được.
        pollingAlive = false;
        log.error(
            { err: error },
            "VÒNG LẶP TELEGRAM CHẾT HẲN — mọi lệnh điều khiển ngừng hoạt động. Mở cầu dao bằng: npm run resume",
        );
    });

    log.info({ commands: [...commands.keys()] }, "Bot Telegram đã sẵn sàng");
}

export async function stopTelegramBot(): Promise<void> {
    if (!bot) return;

    try {
        pollingAlive = false;
        bot.stop();
        if (polling) await polling;
        log.info("Đã dừng bot Telegram");
    } catch (error) {
        log.warn({ err: error }, "Lỗi khi dừng bot Telegram");
    } finally {
        bot = null;
        polling = null;
    }
}
