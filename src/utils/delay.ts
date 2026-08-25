export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Số nguyên ngẫu nhiên trong [min, max]. */
export function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Backoff luỹ thừa có jitter.
 * Jitter quan trọng: nếu nhiều lần retry rơi đúng cùng một mốc thời gian đều đặn,
 * đó lại là một dạng pattern máy móc dễ bị nhận diện.
 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
    const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
    const jitter = randomInt(0, Math.floor(exponential * 0.2));
    return Math.min(exponential + jitter, maxMs);
}
