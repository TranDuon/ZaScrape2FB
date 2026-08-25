/**
 * Kiểm chứng jobQueue với MongoDB thật. Cố ý chạy trên Atlas thật chứ không mock:
 * thứ đang được kiểm chứng ở đây (claim nguyên tử, unique partial index, updateMany theo type)
 * chính là ngữ nghĩa của MongoDB — mock đi thì test còn lại chẳng chứng minh được gì.
 * Chạy: npm run test:jobqueue
 *
 * Tự dọn dẹp toàn bộ job test tạo ra khi kết thúc, kể cả khi có lỗi giữa chừng.
 */
import { ObjectId } from "mongodb";
import { closeMongo, connectMongo } from "../src/db/mongoClient.js";
import { postJobs } from "../src/db/collections.js";
import { claimNextJob, completeJob, enqueueJob, failJob, requeueStaleJobs } from "../src/jobs/jobQueue.js";

let failed = 0;

function check(label: string, ok: boolean): void {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

async function testDuplicateBlocked(listingId: ObjectId): Promise<void> {
    console.log("\n--- Chặn job trùng khi đang chờ/đang chạy ---");

    const first = await enqueueJob({ type: "extract_listing", listingId });
    const second = await enqueueJob({ type: "extract_listing", listingId });

    check("Lần đầu tạo job thành công", first !== null);
    check("Tạo lại job y hệt (cùng attempt_seq) khi job trước còn đang chờ -> bị chặn", second === null);

    if (first?._id) await completeJob(first._id);
}

async function testConcurrentClaim(listingId: ObjectId): Promise<void> {
    console.log("\n--- Claim đồng thời không được nhận trùng job ---");

    const job = await enqueueJob({ type: "extract_listing", listingId, attemptSeq: 1 });
    check("Tạo được job để test claim", job !== null);

    // Bắn 10 lệnh claim cùng lúc, mô phỏng nhiều worker instance chạy song song.
    // findOneAndUpdate phải đảm bảo đúng 1 lệnh nhận được job, 9 lệnh còn lại null.
    const attempts = await Promise.all(Array.from({ length: 10 }, () => claimNextJob("extract_listing")));
    const claimed = attempts.filter((result) => result?._id?.equals(job?._id ?? new ObjectId()));

    check(`Đúng 1/10 lệnh claim đồng thời nhận được job (thực tế: ${claimed.length})`, claimed.length === 1);

    if (claimed[0]?._id) await completeJob(claimed[0]._id);
}

async function testRetryAfterFailure(listingId: ObjectId): Promise<void> {
    console.log("\n--- /retry tạo job mới sau khi job cũ thất bại hẳn ---");

    const job = await enqueueJob({ type: "extract_listing", listingId, attemptSeq: 2, maxAttempts: 1 });
    check("Tạo được job ban đầu", job !== null);
    if (!job) return;

    const claimed = await claimNextJob("extract_listing");
    check("Claim được job vừa tạo", claimed?._id?.equals(job._id) ?? false);
    if (!claimed) return;

    // maxAttempts=1 và claimNextJob đã tăng attempts lên 1 -> hết lượt, phải thất bại hẳn.
    const verdict = await failJob(claimed, new Error("lỗi giả lập để test"), 0);
    check("Hết lượt retry tự động -> chuyển failed", verdict === "failed");

    const failedDoc = await postJobs().findOne({ _id: job._id });
    check("Trạng thái trong DB đúng là failed", failedDoc?.status === "failed");

    // Cùng attempt_seq với job đã failed: unique index chỉ áp dụng cho job CHƯA kết thúc,
    // nên về lý thuyết vẫn tạo lại được — nhưng /retry thật luôn tăng attempt_seq để rõ ràng
    // đây là lần thử khác, nên ta test đúng đường đi thật đó.
    const retried = await enqueueJob({ type: "extract_listing", listingId, attemptSeq: 3 });
    check("Sau khi failed, /retry (attempt_seq mới) tạo được job mới", retried !== null);

    if (retried?._id) await completeJob(retried._id);
}

/**
 * Bug thật đã xảy ra (phát hiện 21/08/2026 qua dữ liệu thật): `buildIdempotencyKey` từng KHÔNG
 * gồm `type` trong hash, nên `extract_listing` và `compose_post` của CÙNG một listing (đều
 * group_id=null, attempt_seq=0) tạo hash giống hệt nhau. Lúc extractionWorker enqueue
 * compose_post, job extract_listing gốc vẫn còn `processing` (unique index áp dụng cho
 * pending/claimed/processing) -> insert bị chặn, lỗi bị enqueueJob nuốt êm thành "job trùng",
 * và MỌI listing `ready` trong lịch sử dự án chưa từng thực sự tạo được job compose_post.
 * Test này mô phỏng đúng trình tự đã gây lỗi để đảm bảo không tái diễn.
 */
async function testDifferentTypesDontCollide(listingId: ObjectId): Promise<void> {
    console.log("\n--- Job khác loại của CÙNG listing không được đụng độ idempotency_key ---");

    const extractJob = await enqueueJob({ type: "extract_listing", listingId, attemptSeq: 20 });
    check("Tạo được job trích xuất", extractJob !== null);
    if (!extractJob?._id) return;

    // Mô phỏng đúng thời điểm gây lỗi: claim job trích xuất (chuyển "processing") RỒI MỚI
    // enqueue job soạn bài cho cùng listing đó — extractionWorker làm đúng thứ tự này.
    const claimed = await claimNextJob("extract_listing");
    check("Claim được job trích xuất (chuyển processing)", claimed?._id?.equals(extractJob._id) ?? false);

    const composeJob = await enqueueJob({ type: "compose_post", listingId });
    check(
        "Enqueue job soạn bài trong lúc job trích xuất CÙNG listing còn processing -> vẫn tạo được",
        composeJob !== null,
    );

    if (composeJob?._id) {
        const differentKeys = extractJob.idempotency_key !== composeJob.idempotency_key;
        check("Hai loại job có idempotency_key KHÁC nhau", differentKeys);
        await completeJob(composeJob._id);
    }

    if (claimed?._id) await completeJob(claimed._id);
}

/**
 * Đây là bài test quan trọng nhất file này: chứng minh tiến trình chết giữa lúc đăng KHÔNG dẫn
 * tới đăng trùng bài. Job trích xuất chết giữa chừng thì chạy lại vô hại; job đăng bài chết giữa
 * chừng thì bài có thể đã nằm trên Facebook rồi, chạy lại là đăng hai lần vào cùng một nhóm.
 */
async function testStaleSweep(listingId: ObjectId): Promise<void> {
    console.log("\n--- Dọn job kẹt: trích xuất chạy lại, đăng bài KHÔNG chạy lại ---");

    const groupId = new ObjectId();
    const extractJob = await enqueueJob({ type: "extract_listing", listingId, attemptSeq: 10 });
    const postJob = await enqueueJob({ type: "post_to_group", listingId, groupId, composedText: "nội dung test" });

    check("Tạo được cả job trích xuất lẫn job đăng bài", extractJob !== null && postJob !== null);
    if (!extractJob?._id || !postJob?._id) return;

    // Giả lập tiến trình chết: cả hai job đang "processing" và đã bị bỏ rơi từ lâu.
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await postJobs().updateMany(
        { _id: { $in: [extractJob._id, postJob._id] } },
        { $set: { status: "processing", claimed_at: longAgo, claimed_by: "tiến-trình-đã-chết" } },
    );

    const sweep = await requeueStaleJobs(15 * 60 * 1000);
    check(`Dọn được job kẹt (requeued=${sweep.requeued}, abandonedPosts=${sweep.abandonedPosts})`, sweep.requeued >= 1 && sweep.abandonedPosts >= 1);

    const extractAfter = await postJobs().findOne({ _id: extractJob._id });
    const postAfter = await postJobs().findOne({ _id: postJob._id });

    check("Job trích xuất -> quay lại pending để chạy lại", extractAfter?.status === "pending");
    check("Job đăng bài -> KHÔNG quay lại pending (nếu không sẽ đăng trùng)", postAfter?.status !== "pending");
    check("Job đăng bài -> đánh dấu failed và kết thúc hẳn", postAfter?.status === "failed" && postAfter.finished_at !== null);
}

async function cleanup(listingId: ObjectId): Promise<void> {
    const result = await postJobs().deleteMany({ "payload.listing_id": listingId });
    console.log(`\nĐã dọn ${result.deletedCount} job test.`);
}

async function main(): Promise<void> {
    await connectMongo();

    // ObjectId giả lập riêng cho lần chạy này, không đụng tới listing thật nào trong DB.
    const listingId = new ObjectId();
    console.log(`listing_id giả lập cho lần test này: ${listingId.toHexString()}`);

    try {
        await testDuplicateBlocked(listingId);
        await testConcurrentClaim(listingId);
        await testRetryAfterFailure(listingId);
        await testDifferentTypesDontCollide(listingId);
        await testStaleSweep(listingId);
    } finally {
        await cleanup(listingId);
    }

    console.log(failed === 0 ? "\nTẤT CẢ ĐỀU ĐẠT" : `\n${failed} kiểm tra THẤT BẠI`);
    await closeMongo();
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
    console.error("Test thất bại:", error instanceof Error ? error.message : error);
    await closeMongo();
    process.exit(1);
});
