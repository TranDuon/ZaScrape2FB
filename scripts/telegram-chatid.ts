/**
 * Lấy chat ID của bạn để điền vào TELEGRAM_CHAT_ID.
 * Chạy: npm run telegram:chatid
 *
 * Trước khi chạy, hãy nhắn một tin bất kỳ cho bot của bạn trên Telegram.
 */
import { env } from "../src/config/env.js";

interface TelegramChat {
    id: number;
    type: string;
    first_name?: string;
    last_name?: string;
    username?: string;
}

async function main(): Promise<void> {
    if (!env.TELEGRAM_BOT_TOKEN) {
        console.error("Thiếu TELEGRAM_BOT_TOKEN trong .env");
        process.exit(1);
    }

    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`);
    const data = (await response.json()) as { ok: boolean; result?: Array<Record<string, any>>; description?: string };

    if (!data.ok) {
        console.error("Telegram trả lỗi:", data.description);
        process.exit(1);
    }

    const chats = new Map<number, TelegramChat>();
    for (const update of data.result ?? []) {
        const message = update.message ?? update.edited_message ?? update.callback_query?.message;
        const chat = message?.chat as TelegramChat | undefined;
        if (chat?.id) chats.set(chat.id, chat);
    }

    if (chats.size === 0) {
        console.log("Chưa thấy tin nhắn nào gửi tới bot.");
        console.log("Hãy mở Telegram, tìm bot của bạn, bấm START rồi nhắn một tin bất kỳ, sau đó chạy lại lệnh này.");
        process.exit(1);
    }

    console.log("\n=== Các cuộc trò chuyện đã nhắn cho bot ===\n");
    for (const chat of chats.values()) {
        const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
        console.log(`  chat_id: ${chat.id}`);
        console.log(`  tên:     ${name || "(không rõ)"}`);
        console.log(`  username: @${chat.username ?? "?"}`);
        console.log(`  loại:    ${chat.type}\n`);
    }

    const first = [...chats.values()][0];
    console.log("Điền dòng này vào .env:");
    console.log(`TELEGRAM_CHAT_ID=${first?.id}`);
    process.exit(0);
}

main().catch((error) => {
    console.error("Lỗi:", error instanceof Error ? error.message : error);
    process.exit(1);
});
