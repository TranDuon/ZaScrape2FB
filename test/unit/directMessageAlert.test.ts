import { describe, expect, it } from "vitest";
import type { Message } from "zca-js";
import { SenderCooldown, describeMessage } from "../../src/zalo/directMessageAlert.js";

function dm(msgType: string, content: unknown): Message {
    return { type: 0, threadId: "u1", isSelf: false, data: { msgType, content, uidFrom: "u1" } } as unknown as Message;
}

describe("SenderCooldown", () => {
    it("tin đầu tiên luôn báo ngay, tin dồn sau đó trong khoảng nguội thì gộp", () => {
        const cooldown = new SenderCooldown(10 * 60_000);
        expect(cooldown.check("u1", 0)).toEqual({ notify: true, suppressed: 0 });
        expect(cooldown.check("u1", 60_000).notify).toBe(false);
        expect(cooldown.check("u1", 120_000).notify).toBe(false);
        // Hết nguội: báo lại, kèm số tin đã gộp.
        expect(cooldown.check("u1", 11 * 60_000)).toEqual({ notify: true, suppressed: 2 });
    });

    it("mỗi người một khoảng nguội riêng", () => {
        const cooldown = new SenderCooldown(10 * 60_000);
        cooldown.check("u1", 0);
        expect(cooldown.check("u2", 1_000).notify).toBe(true);
    });

    it("khoảng nguội 0 = báo mọi tin", () => {
        const cooldown = new SenderCooldown(0);
        cooldown.check("u1", 0);
        expect(cooldown.check("u1", 0).notify).toBe(true);
    });
});

describe("describeMessage", () => {
    it("giữ nguyên tin chữ ngắn", () => {
        expect(describeMessage(dm("webchat", "Phòng còn không ạ"))).toBe("Phòng còn không ạ");
    });

    it("cắt tin chữ quá dài", () => {
        const text = describeMessage(dm("webchat", "a".repeat(500)));
        expect(text.length).toBe(300);
        expect(text.endsWith("…")).toBe(true);
    });

    it("gắn nhãn ảnh và sticker", () => {
        expect(describeMessage(dm("chat.photo", { href: "https://cdn/a.jpg", thumb: "" }))).toBe("[Ảnh]");
        expect(describeMessage(dm("chat.sticker", { id: 1 }))).toBe("[Sticker]");
        expect(describeMessage(dm("chat.voice", { href: "https://cdn/a.aac" }))).toBe("[Tin nhắn thoại]");
    });
});
