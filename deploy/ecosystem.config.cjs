/**
 * Cấu hình pm2 — lựa chọn thay thế cho systemd (deploy/sale-room-agent.service).
 * Chỉ dùng MỘT trong hai, chạy cả hai sẽ có hai tiến trình cùng mở một phiên Zalo và đá nhau ra.
 *
 * Dùng khi không có quyền root trên VPS, hoặc muốn xem log/restart nhanh mà không cần sudo.
 *
 *   npm install -g pm2
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 save && pm2 startup     # tự chạy lại sau khi VPS reboot (chạy lệnh pm2 startup in ra)
 *   pm2 logs sale-room-agent
 *
 * File dùng đuôi .cjs vì package.json khai báo "type": "module" — pm2 đọc file config bằng
 * require(), nên nếu để .js sẽ lỗi "module is not defined".
 */
module.exports = {
    apps: [
        {
            name: "sale-room-agent",
            script: "npx",
            args: "tsx src/index.ts",
            cwd: __dirname + "/..",

            // MỘT instance duy nhất. zca-js chỉ cho phép một phiên Zalo Web mỗi tài khoản:
            // instance thứ hai sẽ đá instance thứ nhất ra và làm ngắt cầu dao Zalo.
            instances: 1,
            exec_mode: "fork",

            env: {
                // BẮT BUỘC — xem chú thích trong sale-room-agent.service.
                TZ: "Asia/Ho_Chi_Minh",
                NODE_ENV: "production",
            },

            autorestart: true,
            // Khởi động lại chậm dần khi lỗi liên tục, tránh quay vòng lúc Atlas đang hỏng.
            restart_delay: 10_000,
            exp_backoff_restart_delay: 1_000,
            max_restarts: 20,

            // Đủ dài để shutdown handler đóng Playwright đúng cách; hồ sơ trình duyệt hỏng
            // đồng nghĩa phải đăng nhập Facebook lại bằng tay.
            kill_timeout: 45_000,

            // Tắt log của pm2: app đã tự ghi logs/app.<ngày>.<n>.log qua pino-roll và tự xoay vòng.
            // Bật cả hai sẽ ghi hai bản y hệt, mà bản của pm2 thì không ai dọn.
            out_file: "/dev/null",
            error_file: "/dev/null",
        },
    ],
};
