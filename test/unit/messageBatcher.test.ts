import { describe, expect, it } from "vitest";
import { MessageBatcher, type CollectedBatch } from "../../src/zalo/messageBatcher.js";

const IDLE_MS = 300;
const HARD_MS = 2000;

const hang = { threadId: "g1", threadType: 1, senderId: "u-hang", senderName: "Bùi Thu Hằng" };
const other = { threadId: "g1", threadType: 1, senderId: "u-khac", senderName: "Người khác" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const at = (offsetMs: number) => new Date(Date.now() + offsetMs);
const img = (id: string) => ({ url: `https://cdn/${id}.jpg`, thumb: null, messageId: id });

/** Tin đăng đầy đủ — dài, có địa chỉ/giá. Dài hơn hẳn ngưỡng nhãn phòng (80 ký tự). */
const fullText = (room: string) =>
    `🏡 Địa chỉ : Số ${room} ngõ 217 Yên Hoà - Cầu Giấy\n🎍 giá : 4tr7\n🎍 Phòng : Studio\n` +
    `❣Nội thất : Đồ cơ bản\n❣Dịch vụ : Điện 3.990/1 số, nước 120k/1 người, internet 150k/1ng\n` +
    `🛑 Lưu ý: Thanh toán 1 cọc 1,5 - Gh 1xe - Khách qua gọi trước 30p`;

function makeBatcher() {
    const flushed: CollectedBatch[] = [];
    const batcher = new MessageBatcher(IDLE_MS, HARD_MS, async (batch) => {
        flushed.push(batch);
    });
    return { batcher, flushed };
}

describe("MessageBatcher — ranh giới phòng là tin chữ", () => {
    it("mỗi tin chữ mở một phòng mới, ảnh theo sau thuộc về phòng đó", async () => {
        const { batcher, flushed } = makeBatcher();

        batcher.addText(hang, "t1", fullText("4"), at(0));
        batcher.addImage(hang, "i1", img("i1"), at(10));
        batcher.addImage(hang, "i2", img("i2"), at(20));

        batcher.addText(hang, "t2", fullText("9"), at(30));
        batcher.addImage(hang, "i3", img("i3"), at(40));

        // Tin chữ thứ 2 phải chốt ngay phòng thứ 1, không cần đợi hết idle window.
        expect(flushed).toHaveLength(1);
        expect(flushed[0]?.images).toHaveLength(2);

        await sleep(IDLE_MS + 200);

        expect(flushed).toHaveLength(2);
        expect(flushed[1]?.images).toHaveLength(1);
        // Mỗi phòng giữ message id riêng -> mediaDownloader tạo thư mục ảnh riêng cho từng phòng.
        expect(flushed[0]?.messageIds[0]).not.toBe(flushed[1]?.messageIds[0]);
    });

    it("dựng lại đúng chuỗi 149 tin thật -> tách thành 20 phòng, không còn gộp một cục", async () => {
        const { batcher, flushed } = makeBatcher();

        // Chuỗi đo được từ dữ liệu thật trong MongoDB (listing 61e222): 20 tin chữ, 129 ảnh,
        // xen kẽ đều đặn. Cách gom theo thời gian cũ cho ra ĐÚNG 1 listing chứa cả 20 phòng.
        const imageCounts = [6, 4, 5, 8, 9, 12, 8, 4, 3, 1, 10, 4, 9, 11, 6, 8, 6, 10, 5];
        const base = Date.now();
        let clock = 0;
        let msgId = 0;

        for (const [roomIndex, count] of imageCounts.entries()) {
            batcher.addText(hang, `t${msgId++}`, fullText(String(roomIndex)), new Date(base + clock));
            clock += 100;

            for (let i = 0; i < count; i++) {
                batcher.addImage(hang, `i${msgId++}`, img(`i${msgId}`), new Date(base + clock));
                clock += 100;
            }
        }

        await sleep(IDLE_MS + 300);

        expect(flushed).toHaveLength(imageCounts.length);
        expect(flushed.map((b) => b.images.length)).toEqual(imageCounts);
        // Tổng ảnh phải khớp, không mất tấm nào trong lúc cắt.
        expect(flushed.reduce((sum, b) => sum + b.images.length, 0)).toBe(129);
    }, 10_000);

    /**
     * Sự cố thật 23/08/2026: tin phòng vào DB với images: 0 kèm 20 dòng WARN "Ảnh đến khi không
     * có batch nào đang mở". Người gửi nhắn tin phòng đầy đủ, rồi một tin chữ NGẮN, rồi mới tới
     * loạt ảnh. Tin ngắn đó chốt mất batch của tin phòng lúc batch còn 0 ảnh, và vì nhãn phòng
     * không mở batch mới nên toàn bộ ảnh gửi sau đó rơi vào hư không.
     */
    it("tin chữ ngắn khi batch CHƯA có ảnh -> viết thêm vào phòng đang mở, ảnh sau đó vẫn được giữ", async () => {
        const { batcher, flushed } = makeBatcher();

        batcher.addText(hang, "t1", fullText("4"), at(0));
        batcher.addText(hang, "t2", "Còn trống nhé cả nhà", at(10));
        batcher.addImage(hang, "i1", img("i1"), at(20));
        batcher.addImage(hang, "i2", img("i2"), at(30));
        batcher.addImage(hang, "i3", img("i3"), at(40));

        // Tin ngắn KHÔNG được chốt batch: nếu chốt thì phòng này ra đời với 0 ảnh.
        expect(flushed).toHaveLength(0);

        await sleep(IDLE_MS + 200);

        expect(flushed).toHaveLength(1);
        expect(flushed[0]?.images).toHaveLength(3);
        expect(flushed[0]?.texts.join("\n")).toContain("Còn trống nhé cả nhà");
    });

    it("tin chữ ngắn khi batch ĐÃ có ảnh vẫn là nhãn phòng mới -> chốt phòng cũ", async () => {
        const { batcher, flushed } = makeBatcher();

        batcher.addText(hang, "t1", fullText("4"), at(0));
        batcher.addImage(hang, "i1", img("i1"), at(10));
        batcher.addText(hang, "t2", "P201 - 4tr2", at(20));

        // Đã có ảnh -> tin ngắn là ranh giới phòng thật, phải chốt ngay.
        expect(flushed).toHaveLength(1);
        expect(flushed[0]?.images).toHaveLength(1);
    });

    it('nhãn phòng ngắn ("P201 - 4tr2") mở phòng mới và KẾ THỪA địa chỉ của tin chữ trước đó', async () => {
        const { batcher, flushed } = makeBatcher();

        batcher.addText(hang, "t1", fullText("38"), at(0));
        batcher.addImage(hang, "i1", img("i1"), at(10));

        // Nhãn phòng ngắn + loạt ảnh riêng của nó → phòng RIÊNG, giữ đủ ảnh.
        batcher.addText(hang, "t2", "P201 - 4tr2", at(20));
        batcher.addImage(hang, "i2", img("i2"), at(30));
        batcher.addImage(hang, "i3", img("i3"), at(40));

        await sleep(IDLE_MS + 200);

        expect(flushed).toHaveLength(2);

        // Phòng 1: tin đầy đủ + ảnh của nó.
        expect(flushed[0]?.images).toHaveLength(1);
        expect(flushed[0]?.texts.join("\n")).not.toContain("P201 - 4tr2");

        // Phòng 2: nhãn + ảnh riêng, và phải có địa chỉ kế thừa — nếu không thì bài đăng vô dụng.
        expect(flushed[1]?.images).toHaveLength(2);
        expect(flushed[1]?.texts.join("\n")).toContain("P201 - 4tr2");
        expect(flushed[1]?.texts.join("\n")).toContain("Yên Hoà");

        // Hai phòng phải có message id đầu khác nhau -> thư mục ảnh riêng.
        expect(flushed[0]?.messageIds[0]).not.toBe(flushed[1]?.messageIds[0]);
    });

    /**
     * Sự cố thật 23/08/2026 13:39: agent vừa khởi động thì nhận ngay nhãn "P303" (chưa có tin
     * chữ đầy đủ nào trong bộ nhớ), rồi 4 tấm ảnh. Nhãn bị bỏ, không mở batch mới, nên cả 4 ảnh
     * rơi vào hư không. Giờ nhãn vẫn mở phòng — thiếu địa chỉ thì báo WARN, nhưng KHÔNG mất ảnh.
     */
    it("nhãn phòng đến khi chưa có ngữ cảnh nào -> vẫn mở phòng và giữ ảnh", async () => {
        const { batcher, flushed } = makeBatcher();

        batcher.addText(hang, "t1", "P303", at(0));
        batcher.addImage(hang, "i1", img("i1"), at(10));
        batcher.addImage(hang, "i2", img("i2"), at(20));

        await sleep(IDLE_MS + 200);

        expect(flushed).toHaveLength(1);
        expect(flushed[0]?.images).toHaveLength(2);
        expect(flushed[0]?.texts.join("\n")).toContain("P303");
    });

    it("ảnh đến trước khi có chữ -> ảnh mồ côi bị bỏ, chỉ giữ ảnh sau tin chữ", async () => {
        const { batcher, flushed } = makeBatcher();

        batcher.addImage(hang, "i1", img("i1"), at(0));
        batcher.addText(hang, "t1", fullText("7"), at(10));
        batcher.addImage(hang, "i2", img("i2"), at(20));

        await sleep(IDLE_MS + 200);

        // Ảnh mồ côi (đến trước khi có text) bị bỏ qua, batch chỉ có ảnh đến sau tin chữ.
        expect(flushed).toHaveLength(1);
        expect(flushed[0]?.images).toHaveLength(1);
        expect(flushed[0]?.texts).toHaveLength(1);
    });

    it("người gửi khác xen giữa -> tách phòng riêng", async () => {
        const { batcher, flushed } = makeBatcher();

        batcher.addText(hang, "t1", fullText("4"), at(0));
        batcher.addImage(hang, "i1", img("i1"), at(10));
        batcher.addText(other, "t2", fullText("99"), at(20));

        await sleep(IDLE_MS + 200);

        expect(flushed).toHaveLength(2);
        expect(flushed.find((b) => b.senderId === "u-hang")?.images).toHaveLength(1);
        expect(flushed.find((b) => b.senderId === "u-khac")?.images).toHaveLength(0);
    });

    it("chốt batch theo trần cứng dù ảnh về liên tục không ngừng", async () => {
        const { batcher, flushed } = makeBatcher();
        const spam = { threadId: "g2", threadType: 1, senderId: "u-spam", senderName: "Spam" };
        const start = Date.now();

        batcher.addText(spam, "t0", fullText("1"), new Date(start));

        let tick = 0;
        const interval = setInterval(() => {
            tick += 1;
            batcher.addImage(spam, `s${tick}`, img(`s${tick}`), new Date(start + tick * 100));
        }, 100);

        await sleep(HARD_MS + 400);
        clearInterval(interval);

        expect(flushed.length).toBeGreaterThan(0);
    }, 10_000);
});

/**
 * Dựng lại đúng chuỗi tin trong ảnh chụp màn hình thật (Ts985, 24/08/2026):
 *   [tin đầy đủ có địa chỉ + 2 phòng trống P101/P601] -> [nhãn "P101 - 4tr6"] -> [3 ảnh]
 *
 * Đây là hình dạng phổ biến nhất trong nhóm: phần chữ mô tả TOÀ NHÀ (địa chỉ, dịch vụ, lưu ý),
 * còn nhãn ngắn chỉ ra ảnh phía sau thuộc phòng nào.
 */
describe("chuỗi thật: tin đầy đủ -> nhãn ngắn -> ảnh", () => {
    const toaNha =
        "🌹 12th 25%\nMã : Ts985\n\n🏠 Địa chỉ : 35A - ngõ 467/139 Lĩnh Nam - Hoàng Mai\n" +
        "⏰ 1/9 Trống : P101,P601\n\n💰 giá : 4tr6,4tr7\n🛏 Phòng : Studio\n🛗 Thang Máy\n" +
        "🪑Nội thất : Full nội thất\n🔧Dịch vụ : Điện 4000 | Nước 35k/khối | Wifi 100k/Tháng\n" +
        "🔴 Lưu ý:\n- Thanh toán 1 cọc 2\n- Thang máy, CHO NUÔI PET\n- KHÔNG NHẬN XE ĐIỆN";

    it("nhãn đến khi batch CHƯA có ảnh -> gộp vào cùng phòng, giữ nguyên địa chỉ và toàn bộ ảnh", async () => {
        const { batcher, flushed } = makeBatcher();

        batcher.addText(hang, "t1", toaNha, at(0));
        batcher.addText(hang, "t2", "P101 - 4tr6", at(10));
        batcher.addImage(hang, "i1", img("i1"), at(20));
        batcher.addImage(hang, "i2", img("i2"), at(30));
        batcher.addImage(hang, "i3", img("i3"), at(40));

        await sleep(IDLE_MS + 200);

        expect(flushed).toHaveLength(1);
        const only = flushed[0]!;
        expect(only.images).toHaveLength(3);
        // Có địa chỉ (từ tin đầy đủ) VÀ có mã phòng (từ nhãn) -> đủ để soạn bài.
        expect(only.texts.join("\n")).toContain("467/139 Lĩnh Nam");
        expect(only.texts.join("\n")).toContain("P101 - 4tr6");
    });

    it("hai nhãn liên tiếp -> hai phòng riêng, phòng nào cũng có địa chỉ và ảnh của mình", async () => {
        const { batcher, flushed } = makeBatcher();

        batcher.addText(hang, "t1", toaNha, at(0));
        batcher.addText(hang, "t2", "P101 - 4tr6", at(10));
        batcher.addImage(hang, "i1", img("i1"), at(20));
        batcher.addImage(hang, "i2", img("i2"), at(30));
        // Nhãn thứ hai đến khi batch ĐÃ có ảnh -> đây mới là ranh giới phòng thật.
        batcher.addText(hang, "t3", "P601 - 4tr7", at(40));
        batcher.addImage(hang, "i3", img("i3"), at(50));

        await sleep(IDLE_MS + 200);

        expect(flushed).toHaveLength(2);

        const p101 = flushed[0]!.texts.join("\n");
        expect(p101).toContain("467/139 Lĩnh Nam");
        expect(p101).toContain("P101 - 4tr6");
        expect(flushed[0]!.images).toHaveLength(2);

        const p601 = flushed[1]!.texts.join("\n");
        // Phòng thứ hai KẾ THỪA địa chỉ từ tin đầy đủ, dù bản thân nhãn không có địa chỉ.
        expect(p601).toContain("467/139 Lĩnh Nam");
        expect(p601).toContain("P601 - 4tr7");
        expect(p601).not.toContain("P101 - 4tr6");
        expect(flushed[1]!.images).toHaveLength(1);

        // Hai phòng, hai thư mục ảnh khác nhau.
        expect(flushed[0]!.messageIds[0]).not.toBe(flushed[1]!.messageIds[0]);
    });
});
