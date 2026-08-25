/**
 * CRUD nhanh cho danh sách Facebook Group qua dòng lệnh — quy mô cá nhân, vài chục group
 * là cùng nên không cần giao diện riêng.
 *
 * Chạy: npm run seed:groups -- <lệnh> [tham số]
 *
 *   list                                                    liệt kê tất cả group
 *   add "<tên>" "<url>" [max/ngày=5] [cách nhau tối thiểu(phút)=180]
 *   toggle <id>                                              bật/tắt active
 *   remove <id>                                              xoá hẳn
 *   areas <id> "<quận,quận>" | --auto                        khai báo tay khu vực nhóm phục vụ
 */
import { ObjectId } from "mongodb";
import { closeMongo, connectMongo } from "../src/db/mongoClient.js";
import { groups } from "../src/db/collections.js";
import type { GroupDoc } from "../src/models/group.model.js";
import { districtsOfGroup } from "../src/facebook/areaMatcher.js";

function printUsageAndExit(): never {
    console.error(`Cách dùng:
  npm run seed:groups -- list
  npm run seed:groups -- add "<tên>" "<url>" [max/ngày] [cách nhau tối thiểu(phút)]
  npm run seed:groups -- toggle <id>
  npm run seed:groups -- remove <id>
  npm run seed:groups -- areas <id> "<quận 1>,<quận 2>"   # khai báo tay khu vực nhóm phục vụ
  npm run seed:groups -- areas <id> --auto                # bỏ khai báo tay, quay lại suy từ tên`);
    process.exit(1);
}

function formatGroup(group: GroupDoc): string {
    const status = group.active ? "BẬT" : "tắt";
    const freq = `${group.post_frequency.max_posts_per_day}/ngày, cách nhau ≥${group.post_frequency.min_interval_minutes}p`;
    const lastPosted = group.last_posted_at
        ? group.last_posted_at.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })
        : "chưa từng đăng";

    // Hiện khu vực nhóm nhận bài: nhóm không suy được khu vực sẽ KHÔNG BAO GIỜ nhận tin nào,
    // nên phải nhìn thấy ngay ở `list` chứ không phải mò trong log lúc đã im lặng bỏ qua.
    const districts = districtsOfGroup(group);
    const source = group.areas && group.areas.length > 0 ? "khai báo tay" : "suy từ tên nhóm";
    const areaLine =
        districts.length > 0
            ? `  khu vực: ${districts.join(", ")} (${source})`
            : `  khu vực: !!! KHÔNG SUY ĐƯỢC — nhóm này sẽ không nhận bài nào. Khai báo tay:\n` +
              `           npm run seed:groups -- areas ${group._id?.toHexString()} "Cầu Giấy,Nam Từ Liêm"`;

    return [
        `[${status}] ${group.name}`,
        `  id: ${group._id?.toHexString()}`,
        `  url: ${group.url}`,
        `  tần suất: ${freq}`,
        areaLine,
        `  đăng gần nhất: ${lastPosted}`,
    ].join("\n");
}

async function setAreas(args: string[]): Promise<void> {
    const [id, raw] = args;
    if (!id || !raw) printUsageAndExit();

    const group = await groups().findOne({ _id: new ObjectId(id) });
    if (!group) {
        console.error(`Không tìm thấy group với id ${id}`);
        process.exit(1);
    }

    const areas =
        raw === "--auto"
            ? null
            : raw
                  .split(",")
                  .map((part) => part.trim())
                  .filter(Boolean);

    await groups().updateOne({ _id: group._id }, { $set: { areas, updated_at: new Date() } });

    const updated = { ...group, areas };
    const districts = districtsOfGroup(updated);

    if (areas && districts.length === 0) {
        // Ghi vẫn ghi, nhưng phải nói thẳng: khai báo không khớp quận nào thì nhóm vẫn câm.
        console.warn(
            `Cảnh báo: "${areas.join(", ")}" không khớp quận nào đang biết — nhóm này vẫn sẽ không nhận bài.`,
        );
    }

    console.log(areas ? `Đã đặt khu vực: ${districts.join(", ") || "(không khớp gì)"}` : "Đã bỏ khai báo tay, quay lại suy từ tên nhóm");
    console.log(formatGroup(updated));
}

async function list(): Promise<void> {
    const all = await groups().find().sort({ created_at: 1 }).toArray();

    if (all.length === 0) {
        console.log("Chưa có group nào. Thêm bằng:");
        console.log(`  npm run seed:groups -- add "Tên nhóm" "https://facebook.com/groups/..."`);
        return;
    }

    console.log(`=== ${all.length} group ===\n`);
    console.log(all.map(formatGroup).join("\n\n"));
}

async function add(args: string[]): Promise<void> {
    const [name, url, maxPerDayRaw, minIntervalRaw] = args;
    if (!name || !url) printUsageAndExit();

    if (!url.includes("facebook.com")) {
        console.warn(`Cảnh báo: "${url}" không giống link Facebook, vẫn lưu nhưng kiểm tra lại nhé.`);
    }

    const maxPerDay = maxPerDayRaw ? Number(maxPerDayRaw) : 5;
    const minInterval = minIntervalRaw ? Number(minIntervalRaw) : 180;

    if (!Number.isFinite(maxPerDay) || maxPerDay <= 0) {
        console.error("max/ngày phải là số dương");
        process.exit(1);
    }
    if (!Number.isFinite(minInterval) || minInterval <= 0) {
        console.error("cách nhau tối thiểu phải là số dương");
        process.exit(1);
    }

    const now = new Date();
    const doc: GroupDoc = {
        name,
        url,
        fb_group_id: null,
        active: true,
        post_frequency: { max_posts_per_day: maxPerDay, min_interval_minutes: minInterval },
        last_posted_at: null,
        posts_today_count: 0,
        notes: null,
        created_at: now,
        updated_at: now,
    };

    const result = await groups().insertOne(doc);
    console.log(`Đã thêm group, id: ${result.insertedId.toHexString()}`);
    console.log(formatGroup({ ...doc, _id: result.insertedId }));
}

async function toggle(args: string[]): Promise<void> {
    const [id] = args;
    if (!id || !ObjectId.isValid(id)) {
        console.error("Cần id hợp lệ. Xem id bằng: npm run seed:groups -- list");
        process.exit(1);
    }

    const group = await groups().findOne({ _id: new ObjectId(id) });
    if (!group) {
        console.error(`Không tìm thấy group với id ${id}`);
        process.exit(1);
    }

    await groups().updateOne({ _id: group._id }, { $set: { active: !group.active, updated_at: new Date() } });
    console.log(`Đã ${group.active ? "TẮT" : "BẬT"} group "${group.name}"`);
}

async function remove(args: string[]): Promise<void> {
    const [id] = args;
    if (!id || !ObjectId.isValid(id)) {
        console.error("Cần id hợp lệ. Xem id bằng: npm run seed:groups -- list");
        process.exit(1);
    }

    const result = await groups().deleteOne({ _id: new ObjectId(id) });
    console.log(result.deletedCount > 0 ? "Đã xoá" : `Không tìm thấy group với id ${id}`);
}

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    if (!command) printUsageAndExit();

    await connectMongo();

    switch (command) {
        case "list":
            await list();
            break;
        case "add":
            await add(rest);
            break;
        case "toggle":
            await toggle(rest);
            break;
        case "remove":
            await remove(rest);
            break;
        case "areas":
            await setAreas(rest);
            break;
        default:
            printUsageAndExit();
    }

    await closeMongo();
}

main().catch((error) => {
    console.error("Lỗi:", error instanceof Error ? error.message : error);
    process.exit(1);
});
