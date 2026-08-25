import { describe, expect, it } from "vitest";
import type { Message } from "zca-js";
import { parseIncomingMessage } from "../../src/zalo/messageParser.js";

function fakeMessage(msgType: string, content: unknown): Message {
    return { type: 1, threadId: "g1", isSelf: false, data: { msgType, content } } as unknown as Message;
}

describe("parseIncomingMessage", () => {
    it("nhận tin nhắn chữ thuần", () => {
        const result = parseIncomingMessage(fakeMessage("webchat", "Phòng 25m2 giá 4tr5"));
        expect(result.kind).toBe("text");
    });

    it("loại tin nhắn chữ rỗng", () => {
        const result = parseIncomingMessage(fakeMessage("webchat", "   "));
        expect(result.kind).toBe("other");
    });

    it("ưu tiên ảnh HD lấy từ params thay vì href", () => {
        const result = parseIncomingMessage(
            fakeMessage("chat.photo", {
                href: "https://cdn/thuong.jpg",
                thumb: "https://cdn/thumb.jpg",
                params: JSON.stringify({ hd: "https://cdn/hd.jpg" }),
            }),
        );
        expect(result.kind).toBe("image");
        expect(result.kind === "image" && result.url).toBe("https://cdn/hd.jpg");
    });

    it("dùng href khi không có params", () => {
        const result = parseIncomingMessage(
            fakeMessage("chat.photo", { href: "https://cdn/a.jpg", thumb: "https://cdn/t.jpg" }),
        );
        expect(result.kind).toBe("image");
    });

    it("bỏ qua sticker", () => {
        const result = parseIncomingMessage(fakeMessage("chat.sticker", { id: 123 }));
        expect(result.kind).toBe("other");
    });

    it("vẫn lấy được chữ từ link có tiêu đề", () => {
        const result = parseIncomingMessage(
            fakeMessage("chat.recommended", { title: "Nhà trọ ABC", description: "Quận 7" }),
        );
        expect(result.kind).toBe("text");
    });

    /**
     * Nhóm test cho sự cố 23/08/2026: mọi tin đăng vào DB với images: 0 và data/images/ rỗng.
     *
     * Nguyên nhân: tin ảnh không khớp nhánh nhận dạng nên rơi xuống nhánh `title` -> thành
     * `kind: "text"`. Trong bộ gom batch, tin chữ là RANH GIỚI PHÒNG, nên mỗi tin ảnh vừa chốt
     * mất batch đang mở, vừa bị vứt (tên file ngắn hơn ngưỡng nhãn phòng), kéo theo mọi ảnh sau
     * đó. Ba test dưới khoá lại đúng cái không được phép tái diễn: ẢNH KHÔNG BAO GIỜ ĐƯỢC
     * TRỞ THÀNH "text".
     */
    describe("tin ảnh không bao giờ bị đọc nhầm thành chữ", () => {
        it("msgType lạ nhưng params có hd -> vẫn là ảnh, không phải chữ", () => {
            const result = parseIncomingMessage(
                fakeMessage("chat.attachment.v2", {
                    title: "photo_2026_08_23.jpg",
                    params: JSON.stringify({ hd: "https://cdn/hd.jpg" }),
                }),
            );
            expect(result.kind).toBe("image");
            expect(result.kind === "image" && result.url).toBe("https://cdn/hd.jpg");
        });

        it("msgType lạ và không có params, nhưng href là đuôi ảnh -> vẫn là ảnh", () => {
            const result = parseIncomingMessage(
                fakeMessage("chat.unknown", { title: "IMG_1234.jpg", href: "https://cdn/IMG_1234.jpg" }),
            );
            expect(result.kind).toBe("image");
        });

        it("nhận ra là ảnh nhưng không moi được URL -> other, TUYỆT ĐỐI không phải text", () => {
            const result = parseIncomingMessage(fakeMessage("chat.photo", { title: "anh.jpg" }));
            // "text" ở đây sẽ chốt nhầm batch và làm mất toàn bộ ảnh của phòng.
            expect(result.kind).toBe("other");
        });

        it("đính kèm không nhận dạng được thì kèm theo manh mối để chẩn đoán", () => {
            const result = parseIncomingMessage(fakeMessage("chat.newtype", { foo: 1, bar: 2 }));
            expect(result.kind).toBe("other");
            expect(result.kind === "other" && result.keys).toEqual(["foo", "bar"]);
        });

        /**
         * Video mang CẢ `title` LẪN `description`, nên nếu không chặn trước nhánh link/recommend
         * thì nó thành `kind: "text"` → chốt mất batch đang mở → bị vứt như nhãn phòng, kéo theo
         * mọi ảnh/video phía sau. Ngày 23/08/2026 nó thoát chỉ vì hai field đó tình cờ rỗng.
         */
        it("video CÓ title/description vẫn không được thành text", () => {
            const result = parseIncomingMessage(
                fakeMessage("chat.video.msg", {
                    title: "video phòng 303",
                    description: "quay ngày 23/08",
                    href: "https://cdn/clip.mp4",
                    thumb: "https://cdn/clip-thumb.jpg",
                }),
            );
            expect(result.kind).toBe("other");
            expect(result.kind === "other" && result.known).toBe(true);
        });

        it("sticker được nhận là loại đã biết, không kêu 'Zalo đổi định dạng'", () => {
            const result = parseIncomingMessage(fakeMessage("chat.sticker", { id: 1, catId: 2, type: 3 }));
            expect(result.kind).toBe("other");
            // `known` là thứ quyết định log ra WARN hay DEBUG ở messageListener.
            expect(result.kind === "other" && result.known).toBe(true);
        });
    });
});
