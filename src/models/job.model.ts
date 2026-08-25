import type { ObjectId } from "mongodb";

export const JOB_TYPES = ["extract_listing", "compose_post", "post_to_group"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUS = ["pending", "claimed", "processing", "done", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

export interface JobDoc {
    _id?: ObjectId;
    type: JobType;
    status: JobStatus;
    payload: {
        listing_id: ObjectId;
        group_id: ObjectId | null;
        /** Snapshot noi dung da chot cho group nay (Module Composer ghi vao). */
        composed_text: string | null;
    };
    attempts: number;
    /** Tang moi lan nguoi dung chu dong /retry, de idempotency_key khac di. */
    attempt_seq: number;
    max_attempts: number;
    /** hash(listing_id + group_id + attempt_seq) - unique partial tren job chua ket thuc. */
    idempotency_key: string;
    last_error: string | null;
    scheduled_at: Date;
    claimed_at: Date | null;
    claimed_by: string | null;
    started_at: Date | null;
    /** Chi set khi job ket thuc - cung la moc de TTL don dep. */
    finished_at: Date | null;
    created_at: Date;
    updated_at: Date;
}
