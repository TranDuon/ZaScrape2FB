import { MongoClient, type Db } from "mongodb";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("db");

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
    if (db) return db;

    client = new MongoClient(env.MONGODB_URI, {
        // Driver đã tự retry các thao tác tạm lỗi; timeout ngắn để phát hiện sớm
        // khi VPS chưa được whitelist IP trên Atlas thay vì treo im lặng.
        serverSelectionTimeoutMS: 10_000,
        retryWrites: true,
        retryReads: true,
    });

    await client.connect();
    db = client.db(env.MONGODB_DB_NAME);
    await db.command({ ping: 1 });

    log.info({ database: env.MONGODB_DB_NAME }, "Đã kết nối MongoDB");
    return db;
}

export function getDb(): Db {
    if (!db) throw new Error("Chưa kết nối MongoDB — gọi connectMongo() trước.");
    return db;
}

export async function closeMongo(): Promise<void> {
    if (!client) return;
    await client.close();
    client = null;
    db = null;
    log.info("Đã đóng kết nối MongoDB");
}
