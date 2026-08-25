/**
 * Kiểm chứng Phase 1: kết nối Atlas, tạo index, khởi tạo app_state.
 * Chạy: npx tsx scripts/check-db.ts
 */
import { connectMongo, closeMongo, getDb } from "../src/db/mongoClient.js";
import { ensureIndexes, ensureAppState } from "../src/db/indexes.js";
import { appState } from "../src/db/collections.js";
import { APP_STATE_ID } from "../src/config/constants.js";
import { logger } from "../src/utils/logger.js";

async function main(): Promise<void> {
    await connectMongo();
    await ensureIndexes();
    await ensureAppState();

    const db = getDb();
    const collections = await db.listCollections().toArray();
    console.log("\n=== Collections ===");
    for (const collection of collections) console.log(" -", collection.name);

    console.log("\n=== Index quan trọng ===");
    for (const name of ["listings", "post_jobs", "post_history"]) {
        const indexes = await db.collection(name).indexes();
        console.log(`\n[${name}]`);
        for (const index of indexes) {
            const flags: string[] = [];
            if (index.unique) flags.push("unique");
            if (index.partialFilterExpression) flags.push("partial");
            if (index.expireAfterSeconds !== undefined) {
                flags.push(`TTL ${Number(index.expireAfterSeconds) / 86400} ngày`);
            }
            console.log(`  ${index.name}: ${JSON.stringify(index.key)}${flags.length ? "  [" + flags.join(", ") + "]" : ""}`);
        }
    }

    const state = await appState().findOne({ _id: APP_STATE_ID });
    console.log("\n=== app_state ===");
    console.log("  ngày hiện tại (giờ VN):", state?.daily_counters.date);
    console.log("  cầu dao Facebook:", state?.circuit_breaker.tripped ? "ĐANG NGẮT" : "bình thường");
    console.log("  cầu dao Zalo:", state?.zalo_circuit_breaker.tripped ? "ĐANG NGẮT" : "bình thường");

    await closeMongo();
    console.log("\nKẾT NỐI ATLAS THÀNH CÔNG — Phase 1 đạt");
}

main().catch((error) => {
    logger.fatal({ err: error }, "Kiểm tra database thất bại");
    process.exit(1);
});
