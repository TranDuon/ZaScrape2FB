import { describe, expect, it } from "vitest";
import { freshApprovalPhrases } from "../../src/facebook/fbPoster.js";

/**
 * Nhận diện "bài đang chờ quản trị viên duyệt" sau khi bấm Đăng.
 *
 * Điểm gãy thật sự của phép nhận diện này KHÔNG phải là bắt được thông báo chờ duyệt — mà là
 * KHÔNG bắt nhầm phần nội quy nhóm. Nhóm bật kiểm duyệt gần như luôn ghi sẵn "bài viết phải được
 * phê duyệt" trong mô tả, và phần chữ đó nằm trên trang từ trước khi ta đăng. Quét chữ cả trang
 * sau khi đăng sẽ báo nhầm cho MỌI bài vào nhóm đó, kể cả bài lên thẳng — nên phải trừ đi ảnh
 * chụp chữ lấy lúc trang nhóm vừa mở.
 */
describe("freshApprovalPhrases", () => {
    it("bắt được thông báo chờ duyệt xuất hiện sau khi đăng", () => {
        const baseline = "Nhóm phòng trọ Hà Nội\n12.000 thành viên\nBạn viết gì đi...";
        const final = `${baseline}\nBài viết của bạn đang chờ phê duyệt`;

        expect(freshApprovalPhrases(baseline, final)).toContain("đang chờ phê duyệt");
    });

    it("KHÔNG báo nhầm khi nội quy nhóm vốn đã ghi chữ phê duyệt", () => {
        // Chữ này nằm sẵn trong phần mô tả nhóm, có mặt ở cả hai lần đọc.
        const rules = "Nội quy: mọi bài viết phải được quản trị viên phê duyệt trước khi hiển thị.";
        const baseline = `Nhóm cho thuê phòng\n${rules}`;
        const final = `${baseline}\nBài viết của bạn đã được đăng.`;

        expect(freshApprovalPhrases(baseline, final)).toEqual([]);
    });

    it("vẫn bắt được thông báo mới dù nội quy nhóm cũng nhắc tới phê duyệt", () => {
        const rules = "Nội quy: mọi bài viết phải được quản trị viên phê duyệt.";
        const baseline = `Nhóm cho thuê phòng\n${rules}`;
        const final = `${baseline}\nBài viết của bạn đang chờ phê duyệt`;

        expect(freshApprovalPhrases(baseline, final)).toContain("đang chờ phê duyệt");
    });

    it("bài lên thẳng thì không có cụm nào", () => {
        const baseline = "Nhóm phòng trọ Hà Nội\nBạn viết gì đi...";
        const final = `${baseline}\nCho thuê phòng Studio ngõ 116 Mễ Trì\nVừa xong`;

        expect(freshApprovalPhrases(baseline, final)).toEqual([]);
    });

    it("nội quy nhóm hiện ra muộn vẫn không bị tính là mới (nền gộp hai lần đọc)", () => {
        // Facebook tải nội dung dần: lần đọc nền đầu tiên (lúc trang nhóm vừa mở) chưa có phần mô
        // tả nhóm, mãi tới trước khi bấm Đăng nó mới hiện. postToGroup vì thế gộp CẢ HAI lần đọc
        // lại làm nền — nếu chỉ dùng lần đầu, chữ nội quy tới muộn sẽ bị coi là "mới xuất hiện".
        const lucMoiMo = "Nhóm cho thuê phòng\n133K thành viên";
        const truocKhiDang = `${lucMoiMo}\nGiới thiệu: bài viết đang chờ phê duyệt sẽ không hiển thị.`;
        const sauKhiDang = `${truocKhiDang}\nĐã đăng bài viết của bạn.`;

        expect(freshApprovalPhrases(`${lucMoiMo}\n${truocKhiDang}`, sauKhiDang)).toEqual([]);
        // Còn nếu chỉ so với lần đọc đầu tiên thì đúng là báo nhầm — đây là lý do phải gộp.
        expect(freshApprovalPhrases(lucMoiMo, sauKhiDang).length).toBeGreaterThan(0);
    });

    it("bắt được giao diện tiếng Anh", () => {
        const baseline = "Rooms for rent Hanoi\nWrite something...";
        const final = `${baseline}\nYour post is pending approval from a group admin`;

        expect(freshApprovalPhrases(baseline, final)).toContain("pending approval");
    });

    it("không phân biệt hoa thường", () => {
        const baseline = "Nhóm phòng trọ";
        const final = "Nhóm phòng trọ\nBÀI VIẾT ĐANG CHỜ PHÊ DUYỆT";

        expect(freshApprovalPhrases(baseline, final).length).toBeGreaterThan(0);
    });

    it("đọc hụt chữ trang (chuỗi rỗng) thì coi như không chờ duyệt, không báo bừa", () => {
        // readVisibleText trả "" khi trang đang chuyển hướng — không được suy ra điều gì từ đó.
        expect(freshApprovalPhrases("bất kỳ nội dung nào", "")).toEqual([]);
    });
});
