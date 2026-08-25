/**
 * Liệt kê các nhóm Zalo của tài khoản để lấy thread ID điền vào ZALO_ALLOWED_THREAD_IDS.
 * Chạy: npm run list:threads
 *
 * Script này chỉ đọc, không gửi tin nhắn và không mở listener.
 */
import { loginWithSavedSession } from "../src/zalo/zaloClient.js";
import { env } from "../src/config/env.js";
import { logger } from "../src/utils/logger.js";

async function main(): Promise<void> {
    const api = await loginWithSavedSession();

    const allGroups = await api.getAllGroups();
    const groupIds = Object.keys(allGroups.gridVerMap);

    if (groupIds.length === 0) {
        console.log("Tài khoản này chưa tham gia nhóm nào.");
        process.exit(0);
    }

    // getGroupInfo nhận cả mảng, lấy một lần cho nhanh thay vì gọi từng nhóm.
    const info = await api.getGroupInfo(groupIds);

    const rows = groupIds.map((groupId) => {
        const group = info.gridInfoMap[groupId];
        return {
            id: groupId,
            name: group?.name ?? "(không đọc được tên)",
            members: group?.totalMember ?? 0,
        };
    });

    rows.sort((a, b) => b.members - a.members);

    const allowed = new Set(env.ZALO_ALLOWED_THREAD_IDS);

    console.log(`\n=== ${rows.length} nhóm Zalo ===\n`);
    for (const [index, row] of rows.entries()) {
        const mark = allowed.has(row.id) ? " <-- đang được lọc trong .env" : "";
        console.log(`${String(index + 1).padStart(2)}. ${row.name}`);
        console.log(`    id: ${row.id}  (${row.members} thành viên)${mark}`);
    }

    console.log(`\nChép ID của các nhóm phòng trọ vào .env, phân tách bằng dấu phẩy:`);
    console.log(`ZALO_ALLOWED_THREAD_IDS=${rows.slice(0, 3).map((row) => row.id).join(",")}`);
    console.log(`\n(dòng trên chỉ là ví dụ lấy 3 nhóm đầu danh sách - thay bằng đúng nhóm bạn cần)`);

    process.exit(0);
}

main().catch((error) => {
    logger.error({ err: error }, "Không liệt kê được nhóm Zalo");
    process.exit(1);
});
