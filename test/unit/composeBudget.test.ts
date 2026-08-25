import { describe, expect, it } from "vitest";
import type { GroupDoc } from "../../src/models/group.model.js";

/**
 * Hai phép tính quyết định toàn bộ chi phí vận hành, nên tách ra test riêng.
 *
 * Bối cảnh: hạn mức đăng Facebook (MAX_POSTS_PER_DAY) mới là nút thắt thật, không phải tiền
 * Gemini. Soạn bài nhiều hơn số bài đăng được trong ngày là trả tiền cho nội dung không bao giờ
 * lên Facebook, đồng thời chất đống job `pending` (không có TTL) cho tới lúc đầy Atlas M0.
 */

/** Bản sao logic của `dailyComposeBudget` trong composerWorker — giữ đồng bộ khi sửa công thức. */
function dailyComposeBudget(maxPostsPerDay: number, maxGroupsPerListing: number): number {
    return Math.max(1, Math.floor(maxPostsPerDay / maxGroupsPerListing));
}

/** Bản sao logic của `pickLeastRecentlyUsed` trong composerWorker. */
function pickLeastRecentlyUsed(
    matched: GroupDoc[],
    limit: number,
    usedInBatch: Map<string, number> = new Map(),
): GroupDoc[] {
    const picked = [...matched]
        .sort((a, b) => {
            const usedA = usedInBatch.get(a.name) ?? 0;
            const usedB = usedInBatch.get(b.name) ?? 0;
            if (usedA !== usedB) return usedA - usedB;
            return (a.last_posted_at?.getTime() ?? 0) - (b.last_posted_at?.getTime() ?? 0);
        })
        .slice(0, limit);

    for (const group of picked) usedInBatch.set(group.name, (usedInBatch.get(group.name) ?? 0) + 1);
    return picked;
}

function group(name: string, lastPostedAt: Date | null): GroupDoc {
    return {
        name,
        url: `https://facebook.com/groups/${name}`,
        fb_group_id: null,
        active: true,
        post_frequency: { max_posts_per_day: 5, min_interval_minutes: 180 },
        last_posted_at: lastPostedAt,
        posts_today_count: 0,
        notes: null,
        created_at: new Date(),
        updated_at: new Date(),
    };
}

describe("dailyComposeBudget", () => {
    it("cấu hình đang dùng: 20 bài/ngày, 5 nhóm/tin -> 4 tin/ngày", () => {
        expect(dailyComposeBudget(20, 5)).toBe(4);
    });

    it("mặc định thận trọng cũ (3 bài/ngày) vẫn cho soạn ít nhất 1 tin", () => {
        // Không được ra 0: 3/5 làm tròn xuống là 0, mà 0 thì hệ thống đứng im vĩnh viễn.
        expect(dailyComposeBudget(3, 5)).toBe(1);
    });

    it("nới hạn mức đăng thì ngân sách soạn bài tự nới theo", () => {
        expect(dailyComposeBudget(50, 5)).toBe(10);
        expect(dailyComposeBudget(20, 2)).toBe(10);
    });
});

describe("pickLeastRecentlyUsed", () => {
    it("ưu tiên nhóm lâu chưa đăng nhất, không phải nhóm đầu danh sách", () => {
        const now = Date.now();
        const matched = [
            group("vua-dang", new Date(now - 60_000)),
            group("dang-hom-qua", new Date(now - 86_400_000)),
            group("chua-tung-dang", null),
        ];

        const picked = pickLeastRecentlyUsed(matched, 2).map((g) => g.name);

        // Nhóm chưa từng đăng phải đứng đầu, nhóm vừa đăng phải bị bỏ ra.
        expect(picked).toEqual(["chua-tung-dang", "dang-hom-qua"]);
    });

    it("cắt đúng số nhóm cho phép khi khớp nhiều hơn hạn mức", () => {
        const matched = Array.from({ length: 10 }, (_, i) => group(`g${i}`, new Date(i * 1000)));
        expect(pickLeastRecentlyUsed(matched, 5)).toHaveLength(5);
    });

    it("khớp ít hơn hạn mức thì lấy hết, không báo lỗi", () => {
        const matched = [group("a", null), group("b", null)];
        expect(pickLeastRecentlyUsed(matched, 5)).toHaveLength(2);
    });
});

/**
 * Ràng buộc dễ quên nhất khi chỉnh hạn mức: MAX_GROUPS_PER_LISTING phải <= POST_VARIATION_COUNT.
 *
 * `assignVariations` chia biến thể theo vòng (`shuffled[index % length]`), nên số nhóm vượt số
 * biến thể là có nhóm nhận lại NGUYÊN VĂN bài của nhóm khác — chính là dấu hiệu đăng spam chéo
 * nhóm mà Facebook dò tìm, và là thứ toàn bộ cơ chế "nhiều biến thể" sinh ra để tránh.
 */
function assignVariations(groupCount: number, variations: string[]): string[] {
    return Array.from({ length: groupCount }, (_, index) => variations[index % variations.length] as string);
}

describe("số nhóm mỗi tin vs số biến thể", () => {
    it("nhóm <= biến thể: mỗi nhóm một bài KHÁC nhau", () => {
        const assigned = assignVariations(3, ["A", "B", "C"]);
        expect(new Set(assigned).size).toBe(3);
    });

    it("nhóm > biến thể: bắt đầu có nhóm nhận lại nguyên văn bài của nhóm khác", () => {
        const assigned = assignVariations(5, ["A", "B", "C"]);
        // 5 nhóm nhưng chỉ 3 nội dung -> 2 nhóm bị trùng chữ.
        expect(assigned).toHaveLength(5);
        expect(new Set(assigned).size).toBe(3);
    });

    it("cấu hình đang dùng (3 nhóm / 3 biến thể) không sinh bài trùng nào", () => {
        const assigned = assignVariations(3, ["A", "B", "C"]);
        expect(new Set(assigned).size).toBe(assigned.length);
    });
});

/**
 * Với MAX_GROUPS_PER_LISTING=1, mỗi tin chỉ chọn ĐÚNG một nhóm. `last_posted_at` chỉ đổi khi bài
 * thật sự lên Facebook (muộn hơn nhiều), nên trong lúc soạn cả lô nó là hằng số — không đếm số
 * lần đã dùng TRONG LÔ thì mọi tin cùng quận sẽ chọn trùng đúng một nhóm, dồn hết bài vào một chỗ
 * trong khi các nhóm còn lại nằm không.
 */
describe("rải nhóm trong cùng một lô", () => {
    it("nhiều tin cùng quận -> mỗi tin một nhóm khác nhau, không dồn một chỗ", () => {
        const matched = [group("A", null), group("B", null), group("C", null)];
        const used = new Map<string, number>();

        const first = pickLeastRecentlyUsed(matched, 1, used);
        const second = pickLeastRecentlyUsed(matched, 1, used);
        const third = pickLeastRecentlyUsed(matched, 1, used);

        expect(new Set([first[0]!.name, second[0]!.name, third[0]!.name]).size).toBe(3);
    });

    it("hết nhóm khác nhau thì mới quay vòng lại — vẫn đăng, không bỏ tin", () => {
        const matched = [group("A", null), group("B", null)];
        const used = new Map<string, number>();

        const picks = [1, 2, 3, 4].map(() => pickLeastRecentlyUsed(matched, 1, used)[0]!.name);

        // 4 tin / 2 nhóm -> mỗi nhóm đúng 2 lần, phân bố đều chứ không dồn 4 vào một nhóm.
        expect(picks.filter((n) => n === "A")).toHaveLength(2);
        expect(picks.filter((n) => n === "B")).toHaveLength(2);
    });

    it("không có bộ đếm lô (hành vi cũ) -> mọi tin chọn trùng một nhóm", () => {
        const matched = [group("A", null), group("B", null), group("C", null)];

        // Mỗi lần gọi với Map rỗng = không nhớ gì -> luôn ra cùng một nhóm.
        const a = pickLeastRecentlyUsed(matched, 1)[0]!.name;
        const b = pickLeastRecentlyUsed(matched, 1)[0]!.name;
        expect(a).toBe(b);
    });
});
