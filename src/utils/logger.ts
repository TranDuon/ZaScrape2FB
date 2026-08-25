import path from "node:path";
import pino from "pino";
import { env } from "../config/env.js";

/** Timestamp theo giờ VN cho dễ đối chiếu với hành vi thật, thay vì UTC của VPS. */
const timestamp = () => `,"time":"${new Date().toLocaleString("sv-SE", { timeZone: env.TZ })}"`;

// Luôn ghi ra file xoay vòng theo ngày (pino-roll), bất kể LOG_PRETTY: đây là bản ghi bền vững
// dùng để soát lại sau — ví dụ khi Facebook checkpoint xảy ra lúc không ai đang xem console.
// Song song đó vẫn in ra console (đẹp lúc dev, JSON thô lúc production) để `npm run dev` /
// `pm2 logs` vẫn xem được trực tiếp.
const targets: pino.TransportTargetOptions[] = [
    {
        target: "pino-roll",
        options: {
            file: path.join(env.LOG_DIR, "app"),
            frequency: "daily",
            dateFormat: "yyyy-MM-dd",
            mkdir: true,
            extension: ".log",
            limit: { count: env.LOG_RETENTION_DAYS },
        },
        level: env.LOG_LEVEL,
    },
    env.LOG_PRETTY
        ? {
              target: "pino-pretty",
              options: { colorize: true, translateTime: false, ignore: "pid,hostname" },
              level: env.LOG_LEVEL,
          }
        : {
              target: "pino/file",
              options: { destination: 1 }, // stdout
              level: env.LOG_LEVEL,
          },
];

export const logger = pino({
    level: env.LOG_LEVEL,
    timestamp,
    transport: { targets },
});

/** Logger con gắn nhãn module, giúp lọc log theo từng phần của pipeline. */
export function childLogger(module: string) {
    return logger.child({ module });
}
