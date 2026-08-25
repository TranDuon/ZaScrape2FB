/**
 * Khớp khu vực của tin đăng với khu vực mà nhóm Facebook phục vụ.
 *
 * Lý do tồn tại: trước đây mọi tin đều được đăng lên MỌI nhóm đang bật. Một phòng ở Hoàng Mai
 * rơi vào nhóm "Tìm phòng trọ Cầu Giấy - Mỹ Đình" vừa vô ích với người đọc, vừa là cách nhanh
 * nhất để bị report/kick khỏi nhóm — mà mất nhóm thì không lấy lại được.
 *
 * Nguồn khu vực của một nhóm, theo thứ tự ưu tiên:
 *   1. `group.areas` — do người vận hành khai báo tay, luôn thắng. Tên nhóm trên Facebook là
 *      chuỗi tự do, chủ nhóm đổi lúc nào cũng được, nên phải có đường ghi đè thủ công.
 *   2. Suy ra từ chính tên nhóm — tiện, dùng ngay được, nhưng chỉ là phỏng đoán.
 */

/** Bỏ dấu tiếng Việt và hạ chữ thường: "Cầu Giấy" -> "cau giay". */
export function normalizeArea(text: string): string {
    return text
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // bỏ dấu thanh + dấu mũ
        .replace(/đ/gi, "d")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * Quận/huyện Hà Nội, kèm các tên gọi dân dã hay xuất hiện trong tên nhóm và trong địa chỉ.
 *
 * Phần bí danh quan trọng ngang phần tên quận: người ta đặt tên nhóm và viết địa chỉ theo tên
 * phường/khu/đường ("Mỹ Đình", "Ngã Tư Sở", "Triều Khúc") nhiều hơn theo tên quận. Thiếu bí danh
 * thì một nhóm phủ đúng khu vực vẫn bị loại, và tin đăng không tìm được nhóm nào để đăng.
 */
const DISTRICT_ALIASES: Record<string, string[]> = {
    "cau giay": ["cau giay", "dich vong", "nghia tan", "yen hoa", "trung kinh", "quan hoa", "mai dich"],
    "nam tu liem": ["nam tu liem", "my dinh", "me tri", "phu do", "tu liem", "cau dien"],
    "bac tu liem": ["bac tu liem", "co nhue", "xuan dinh", "minh khai", "pham van dong"],
    "thanh xuan": ["thanh xuan", "nga tu so", "trieu khuc", "khuong dinh", "khuong trung", "kim giang", "chinh kinh", "nhan chinh"],
    "dong da": ["dong da", "kham thien", "lang ha", "thai ha", "o cho dua", "ton duc thang", "chua boc"],
    "ba dinh": ["ba dinh", "kim ma", "giang vo", "cong vi", "ngoc khanh", "doi can"],
    "hoang mai": ["hoang mai", "linh nam", "tam trinh", "dinh cong", "giap bat", "tan mai", "vinh hung", "dong thien", "phap van"],
    "hai ba trung": ["hai ba trung", "bach khoa", "minh khai hbt", "vinh tuy", "truong dinh", "bach mai"],
    "ha dong": ["ha dong", "van quan", "mo lao", "yen nghia", "duong noi", "phu la", "quang trung hd"],
    "long bien": ["long bien", "viet hung", "sai dong", "bo de", "ngoc lam", "gia lam"],
    "tay ho": ["tay ho", "xuan la", "nhat tan", "quang an", "buoi", "au co"],
    "hoan kiem": ["hoan kiem", "hang bai", "cua nam", "phuc tan", "chuong duong"],
    "thanh tri": ["thanh tri", "ngu hiep", "tu hiep", "van dien"],
    "hoai duc": ["hoai duc", "an khanh", "van canh", "song phuong"],
    "dan phuong": ["dan phuong"],
    "gia lam huyen": ["trau quy", "duong xa"],
    "dong anh": ["dong anh", "co loa"],
};

/**
 * Trích mọi quận được nhắc tới trong một chuỗi bất kỳ (tên nhóm, hoặc địa chỉ tin đăng).
 *
 * Trả về nhiều quận là chuyện bình thường và đúng: một nhóm thường phủ vài quận liền kề
 * ("Đống Đa - Ba Đình - Thanh Xuân"), và một địa chỉ cũng có thể nhắc cả tên phường lẫn tên quận.
 */
export function extractDistricts(text: string): string[] {
    if (!text) return [];

    const haystack = ` ${normalizeArea(text)} `;
    const found = new Set<string>();

    for (const [district, aliases] of Object.entries(DISTRICT_ALIASES)) {
        for (const alias of aliases) {
            if (haystack.includes(` ${alias} `)) {
                found.add(district);
                break;
            }
        }
    }

    return [...found];
}

export interface AreaSource {
    /** Khu vực khai báo tay. Có giá trị thì thắng tuyệt đối, không suy đoán từ tên nữa. */
    areas?: string[] | null;
    name: string;
}

/** Các quận mà một nhóm phục vụ. Rỗng = không xác định được (xem `matchGroupsToArea`). */
export function districtsOfGroup(group: AreaSource): string[] {
    if (group.areas && group.areas.length > 0) {
        return [...new Set(group.areas.flatMap((area) => extractDistricts(area)))];
    }

    return extractDistricts(group.name);
}

export interface ListingArea {
    district: string | null;
    ward: string | null;
    raw: string | null;
}

/**
 * Các quận của một tin đăng.
 *
 * Không chỉ đọc `address.district`: Gemini thường để trống field đó khi tin nhắn gốc chỉ ghi
 * mỗi tên đường/phường ("Số 11/49/139 Tam Trinh"), nên phải quét cả `ward` và `raw` — chính
 * chuỗi thô mới là nơi tên khu vực hay nằm nhất.
 */
export function districtsOfListing(address: ListingArea): string[] {
    const parts = [address.district, address.ward, address.raw].filter((part): part is string => Boolean(part));
    return [...new Set(parts.flatMap((part) => extractDistricts(part)))];
}

export interface AreaMatchResult<T> {
    matched: T[];
    /** Quận suy ra được từ tin đăng — để log/thông báo nói rõ vì sao không có nhóm nào khớp. */
    listingDistricts: string[];
    /** Nhóm không suy ra được khu vực nào, bị bỏ qua thay vì đăng bừa. */
    unknownAreaGroups: string[];
}

/**
 * Lọc danh sách nhóm xuống những nhóm phủ đúng khu vực của tin đăng.
 *
 * Hai trường hợp "không xác định" đều FAIL CLOSED — thà không đăng còn hơn đăng nhầm khu vực:
 * - Tin đăng không suy ra được quận nào -> trả rỗng, tin nằm lại `ready` chờ người xem.
 * - Nhóm không suy ra được khu vực nào -> bỏ nhóm đó ra, và nêu tên trong `unknownAreaGroups`
 *   để người vận hành biết mà khai báo `areas` bằng tay.
 */
export function matchGroupsToArea<T extends AreaSource>(groups: T[], address: ListingArea): AreaMatchResult<T> {
    const listingDistricts = districtsOfListing(address);
    const unknownAreaGroups: string[] = [];

    if (listingDistricts.length === 0) {
        return { matched: [], listingDistricts, unknownAreaGroups };
    }

    const matched = groups.filter((group) => {
        const groupDistricts = districtsOfGroup(group);

        if (groupDistricts.length === 0) {
            unknownAreaGroups.push(group.name);
            return false;
        }

        return groupDistricts.some((district) => listingDistricts.includes(district));
    });

    return { matched, listingDistricts, unknownAreaGroups };
}
