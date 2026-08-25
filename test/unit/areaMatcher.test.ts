import { describe, expect, it } from "vitest";
import {
    districtsOfGroup,
    districtsOfListing,
    extractDistricts,
    matchGroupsToArea,
    normalizeArea,
} from "../../src/facebook/areaMatcher.js";

/** Ba nhóm THẬT đang dùng — tên lấy nguyên văn từ MongoDB, kể cả cách viết hoa/thiếu dấu. */
const REAL_GROUPS = [
    { name: "Tìm phòng trọ khu vực cầu giấy - Mỹ đình" },
    { name: "Phòng Trọ Thanh Xuân, Ngã Tư Sở, Đống Đa, Hà Nội" },
    { name: "Tìm Phòng Trọ Đống Đa- Ba Đình - Thanh Xuân Hà Nội" },
];

const address = (raw: string | null, district: string | null = null, ward: string | null = null) => ({
    raw,
    district,
    ward,
});

describe("normalizeArea", () => {
    it("bỏ dấu tiếng Việt và hạ chữ thường", () => {
        expect(normalizeArea("Cầu Giấy")).toBe("cau giay");
        expect(normalizeArea("Đống Đa")).toBe("dong da");
        expect(normalizeArea("Nam Từ Liêm")).toBe("nam tu liem");
    });

    it("gộp mọi ký tự phân cách về một khoảng trắng", () => {
        expect(normalizeArea("Đống Đa- Ba Đình - Thanh Xuân")).toBe("dong da ba dinh thanh xuan");
    });
});

describe("extractDistricts", () => {
    it("nhận ra quận dù tên viết thiếu dấu hay sai hoa thường", () => {
        expect(extractDistricts("khu vực cầu giấy")).toEqual(["cau giay"]);
        expect(extractDistricts("CAU GIAY")).toEqual(["cau giay"]);
    });

    it("suy được quận từ tên phường/khu, không chỉ từ tên quận", () => {
        // Địa chỉ thật hay chỉ ghi tên đường; thiếu bí danh là tin đăng không tìm được nhóm nào.
        expect(extractDistricts("Số 11/49/139 Tam Trinh")).toEqual(["hoang mai"]);
        expect(extractDistricts("145 Chính Kinh")).toEqual(["thanh xuan"]);
        expect(extractDistricts("ngõ 217 Yên Hoà")).toEqual(["cau giay"]);
        expect(extractDistricts("Mỹ Đình")).toEqual(["nam tu liem"]);
    });

    it("một chuỗi nhắc nhiều quận thì trả về đủ", () => {
        const found = extractDistricts("Đống Đa - Ba Đình - Thanh Xuân");
        expect(found.sort()).toEqual(["ba dinh", "dong da", "thanh xuan"]);
    });

    it("chuỗi không có khu vực nào thì trả rỗng", () => {
        expect(extractDistricts("4tr8")).toEqual([]);
        expect(extractDistricts("")).toEqual([]);
    });
});

describe("districtsOfGroup — trên đúng 3 tên nhóm thật", () => {
    it("suy đúng khu vực cho cả ba nhóm", () => {
        expect(districtsOfGroup(REAL_GROUPS[0]!).sort()).toEqual(["cau giay", "nam tu liem"]);
        expect(districtsOfGroup(REAL_GROUPS[1]!).sort()).toEqual(["dong da", "thanh xuan"]);
        expect(districtsOfGroup(REAL_GROUPS[2]!).sort()).toEqual(["ba dinh", "dong da", "thanh xuan"]);
    });

    it("`areas` khai báo tay THẮNG tên nhóm", () => {
        const group = { name: "Tìm phòng trọ khu vực cầu giấy - Mỹ đình", areas: ["Hoàng Mai"] };
        // Tên nhóm nói Cầu Giấy nhưng người vận hành đã khai báo khác -> nghe người vận hành.
        expect(districtsOfGroup(group)).toEqual(["hoang mai"]);
    });
});

describe("districtsOfListing", () => {
    it("dùng được district khi Gemini điền sẵn", () => {
        expect(districtsOfListing(address(null, "Thanh Xuân"))).toEqual(["thanh xuan"]);
    });

    it("suy từ raw khi district để trống — trường hợp phổ biến nhất trong dữ liệu thật", () => {
        expect(districtsOfListing(address("Số 11/49/139 Tam Trinh"))).toEqual(["hoang mai"]);
    });
});

describe("matchGroupsToArea", () => {
    it("phòng Thanh Xuân chỉ vào 2 nhóm có Thanh Xuân, không vào nhóm Cầu Giấy", () => {
        const result = matchGroupsToArea(REAL_GROUPS, address("145 Chính Kinh", "Thanh Xuân"));

        expect(result.matched).toHaveLength(2);
        expect(result.matched.map((g) => g.name)).not.toContain("Tìm phòng trọ khu vực cầu giấy - Mỹ đình");
    });

    /**
     * Ca này chính là lý do tính năng tồn tại: trước đây phòng Hoàng Mai vẫn bị đăng lên cả ba
     * nhóm Cầu Giấy/Thanh Xuân/Đống Đa. Không nhóm nào phủ Hoàng Mai -> KHÔNG đăng, chứ không
     * phải đăng bừa vào nhóm gần nhất.
     */
    it("phòng Hoàng Mai không khớp nhóm nào -> trả rỗng, KHÔNG đăng bừa", () => {
        const result = matchGroupsToArea(REAL_GROUPS, address("201 Lĩnh Nam", "Hoàng Mai"));

        expect(result.matched).toHaveLength(0);
        expect(result.listingDistricts).toEqual(["hoang mai"]);
    });

    it("phòng không xác định được quận -> fail closed, không đăng", () => {
        const result = matchGroupsToArea(REAL_GROUPS, address("4tr8"));

        expect(result.matched).toHaveLength(0);
        expect(result.listingDistricts).toEqual([]);
    });

    it("nhóm không suy được khu vực thì bị loại và được nêu tên để khai báo tay", () => {
        const groups = [...REAL_GROUPS, { name: "Hội chợ đồ cũ giá rẻ" }];
        const result = matchGroupsToArea(groups, address("145 Chính Kinh", "Thanh Xuân"));

        expect(result.matched.map((g) => g.name)).not.toContain("Hội chợ đồ cũ giá rẻ");
        expect(result.unknownAreaGroups).toContain("Hội chợ đồ cũ giá rẻ");
    });
});
