import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["test/unit/**/*.test.ts"],
        // Test dùng thẳng .env thật (connection Atlas, model Gemini...) giống các script
        // manual/integration khác trong dự án — không mock hoá toàn bộ vì đây là dự án cá nhân,
        // không chạy CI, và một số test (scheduleLogic) chỉ mock phần DB/network, còn lại
        // vẫn đọc cấu hình thật qua src/config/env.ts.
        globals: false,
    },
});
