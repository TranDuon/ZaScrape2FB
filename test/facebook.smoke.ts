/**
 * Kiểm chứng phần logic Facebook mà KHÔNG đụng tới Facebook thật.
 * Chạy: npm run test:facebook
 *
 * Ba thứ được kiểm tra ở đây đều là chỗ dễ gây hỏng tài khoản nhất:
 *   1. Bộ dò checkpoint — bỏ sót một dấu hiệu chặn nghĩa là agent cứ thao tác tiếp
 *      trong lúc Facebook đang nghi ngờ.
 *   2. Chuỗi selector dự phòng — hỏng thì agent bấm nhầm chỗ.
 *   3. Bộ giới hạn tần suất — hỏng thì đăng vượt hạn mức.
 *
 * Trang web giả được dựng bằng page.setContent() nên hoàn toàn ngoại tuyến.
 */

// Ép khung giờ hoạt động thành cả ngày TRƯỚC khi env.ts đọc process.env,
// nếu không kết quả test sẽ khác nhau tuỳ giờ chạy.
process.env.ACTIVE_HOURS_START = "0";
process.env.ACTIVE_HOURS_END = "24";

export {};

const { ObjectId } = await import("mongodb");
const { chromium } = await import("playwright");
const { connectMongo, closeMongo } = await import("../src/db/mongoClient.js");
const { appState, groups } = await import("../src/db/collections.js");
const { APP_STATE_ID } = await import("../src/config/constants.js");
const { detectCheckpoint } = await import("../src/facebook/checkpointDetector.js");
const { findOptional } = await import("../src/facebook/fbSelectors.js");
const { checkPostingAllowed, isWithinActiveHours } = await import("../src/facebook/rateLimiter.js");
type GroupDoc = import("../src/models/group.model.js").GroupDoc;

let failed = 0;

function check(label: string, ok: boolean): void {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

function pageHtml(body: string): string {
    return `<!doctype html><html lang="vi"><body>${body}</body></html>`;
}

async function testCheckpointDetector(): Promise<void> {
    console.log("\n--- Dò dấu hiệu Facebook chặn ---");

    const browser = await chromium.launch({ headless: true, channel: "chrome" });
    const page = await browser.newPage();

    const cases: Array<{ label: string; html: string; shouldDetect: boolean; kind?: string }> = [
        {
            label: "Trang nhóm bình thường -> không báo động giả",
            html: pageHtml('<div role="navigation" aria-label="Facebook"></div><div>Bạn viết gì đi...</div>'),
            shouldDetect: false,
        },
        {
            label: "Yêu cầu xác minh danh tính -> checkpoint",
            html: pageHtml("<h1>Hãy xác nhận đây là bạn</h1><p>Chúng tôi cần xác minh tài khoản của bạn</p>"),
            shouldDetect: true,
            kind: "checkpoint",
        },
        {
            label: "Kiểm tra bảo mật -> captcha",
            html: pageHtml("<h1>Kiểm tra bảo mật</h1><p>Nhập các ký tự bạn nhìn thấy</p>"),
            shouldDetect: true,
            kind: "captcha",
        },
        {
            label: "Tài khoản bị khoá -> blocked",
            html: pageHtml("<h1>Tài khoản của bạn đã bị khóa</h1><p>Vi phạm tiêu chuẩn cộng đồng</p>"),
            shouldDetect: true,
            kind: "blocked",
        },
        {
            label: "Thao tác quá nhanh -> rate_limited",
            html: pageHtml("<div>Bạn đang thực hiện thao tác này quá nhanh. Hãy thử lại sau.</div>"),
            shouldDetect: true,
            kind: "rate_limited",
        },
        {
            label: "Giao diện tiếng Anh cũng nhận ra",
            html: pageHtml("<h1>Please confirm it's you</h1>"),
            shouldDetect: true,
            kind: "checkpoint",
        },
    ];

    for (const testCase of cases) {
        await page.setContent(testCase.html);
        const result = await detectCheckpoint(page);
        const ok = result.detected === testCase.shouldDetect && (!testCase.kind || result.kind === testCase.kind);
        check(`${testCase.label}${result.detected ? ` (${result.kind})` : ""}`, ok);
    }

    // URL là tín hiệu chắc chắn nhất, chắc hơn dò chữ trong trang.
    await page.route("**/*", (route) => route.fulfill({ body: pageHtml("<div>trang bất kỳ</div>") }));
    await page.goto("https://www.facebook.com/checkpoint/12345");
    const urlResult = await detectCheckpoint(page);
    check(`URL chứa /checkpoint/ -> nhận ra ngay (${urlResult.kind})`, urlResult.detected && urlResult.kind === "checkpoint");

    await page.goto("https://www.facebook.com/login/");
    const loginResult = await detectCheckpoint(page);
    check(`URL chứa /login/ -> nhận ra là đã đăng xuất (${loginResult.kind})`, loginResult.kind === "logged_out");

    await browser.close();
}

async function testSelectorFallback(): Promise<void> {
    console.log("\n--- Chuỗi selector dự phòng ---");

    const browser = await chromium.launch({ headless: true, channel: "chrome" });
    const page = await browser.newPage();

    // Giao diện "hiện tại": selector đầu tiên khớp.
    await page.setContent(pageHtml('<div role="button">Bạn viết gì đi...</div>'));
    const primary = await findOptional(page, "openComposer", 3_000);
    check("Tìm được ô soạn bài theo selector chính", primary !== null);

    // Giao diện tiếng Anh: selector đầu hỏng, phải rơi xuống phương án dự phòng.
    await page.setContent(pageHtml('<div role="button">Write something...</div>'));
    const fallback = await findOptional(page, "openComposer", 4_000);
    check("Giao diện tiếng Anh -> vẫn tìm được nhờ selector dự phòng", fallback !== null);

    // Facebook đổi hoàn toàn: mọi selector đều hỏng, phải trả về null chứ không treo.
    await page.setContent(pageHtml("<div>giao diện hoàn toàn khác</div>"));
    const missing = await findOptional(page, "openComposer", 3_000);
    check("Không phần tử nào khớp -> trả về null (để nơi gọi báo lỗi rõ ràng)", missing === null);

    // Ô nhập nội dung nằm trong hộp thoại.
    await page.setContent(pageHtml('<div role="dialog"><div contenteditable="true" role="textbox"></div></div>'));
    const input = await findOptional(page, "composerInput", 3_000);
    check("Tìm được ô nhập nội dung trong hộp thoại", input !== null);

    await browser.close();
}

async function testRateLimiter(): Promise<void> {
    console.log("\n--- Bộ giới hạn tần suất ---");

    // Truyền giờ tường minh (8h-22h) thay vì đọc .env: file này đã ép ACTIVE_HOURS=0-24
    // để phần kiểm tra bên dưới chạy ổn định bất kể giờ thực tế.
    // 02:00 giờ VN = 19:00 UTC hôm trước.
    check("2h sáng giờ VN nằm ngoài khung 8h-22h", !isWithinActiveHours(new Date("2026-08-19T19:00:00Z"), 8, 22));
    // 14:00 giờ VN = 07:00 UTC.
    check("14h chiều giờ VN nằm trong khung 8h-22h", isWithinActiveHours(new Date("2026-08-20T07:00:00Z"), 8, 22));
    // Ranh giới: đúng 22h là NGOÀI khung (dùng < chứ không <=). 22:00 VN = 15:00 UTC.
    check("Đúng 22h giờ VN đã nằm ngoài khung", !isWithinActiveHours(new Date("2026-08-20T15:00:00Z"), 8, 22));
    // 08:00 VN = 01:00 UTC — đúng giờ bắt đầu thì được tính là trong khung.
    check("Đúng 8h giờ VN nằm trong khung", isWithinActiveHours(new Date("2026-08-20T01:00:00Z"), 8, 22));

    const groupId = new ObjectId();
    const now = new Date();

    const testGroup: GroupDoc = {
        _id: groupId,
        name: "Nhóm test tạm",
        url: "https://facebook.com/groups/test",
        fb_group_id: null,
        active: true,
        post_frequency: { max_posts_per_day: 2, min_interval_minutes: 180 },
        last_posted_at: null,
        posts_today_count: 0,
        notes: null,
        created_at: now,
        updated_at: now,
    };

    const savedState = await appState().findOne({ _id: APP_STATE_ID });

    try {
        await groups().insertOne(testGroup);

        const fresh = await checkPostingAllowed(testGroup);
        check(`Group mới, chưa đăng gì -> cho phép (${fresh.reason})`, fresh.allowed);

        const maxed = await checkPostingAllowed({ ...testGroup, posts_today_count: 2 });
        check("Group đã đạt hạn mức ngày -> chặn", !maxed.allowed);
        check("Chặn vì hạn mức thì hẹn giờ thử lại, không huỷ job", maxed.retryAt !== null);

        const tooSoon = await checkPostingAllowed({ ...testGroup, last_posted_at: new Date(Date.now() - 30 * 60_000) });
        check("Mới đăng 30 phút trước, yêu cầu cách 180 phút -> chặn", !tooSoon.allowed);

        const longAgo = await checkPostingAllowed({ ...testGroup, last_posted_at: new Date(Date.now() - 200 * 60_000) });
        check("Đăng cách đây 200 phút -> cho phép", longAgo.allowed);

        // Cầu dao phải được kiểm tra TRƯỚC mọi điều kiện khác: đã ngắt thì hạn mức
        // còn hay hết cũng không quan trọng nữa.
        await appState().updateOne(
            { _id: APP_STATE_ID },
            { $set: { "circuit_breaker.tripped": true, "circuit_breaker.reason": "test" } },
        );

        const tripped = await checkPostingAllowed(testGroup);
        check("Cầu dao ngắt -> chặn mọi thứ", !tripped.allowed);
        check("Cầu dao ngắt -> KHÔNG hẹn giờ tự thử lại (chờ người xác nhận)", tripped.retryAt === null);
    } finally {
        await groups().deleteOne({ _id: groupId });

        // Trả app_state về đúng trạng thái trước khi test, tránh để lại cầu dao ngắt.
        if (savedState) {
            await appState().updateOne(
                { _id: APP_STATE_ID },
                {
                    $set: {
                        "circuit_breaker.tripped": savedState.circuit_breaker.tripped,
                        "circuit_breaker.reason": savedState.circuit_breaker.reason,
                    },
                },
            );
        }
        console.log("\nĐã dọn group test và khôi phục trạng thái cầu dao.");
    }
}

async function main(): Promise<void> {
    await connectMongo();

    await testCheckpointDetector();
    await testSelectorFallback();
    await testRateLimiter();

    console.log(failed === 0 ? "\nTẤT CẢ ĐỀU ĐẠT" : `\n${failed} kiểm tra THẤT BẠI`);
    await closeMongo();
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
    console.error("Test thất bại:", error instanceof Error ? error.message : error);
    await closeMongo();
    process.exit(1);
});
