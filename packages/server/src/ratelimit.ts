/** Classic token bucket: `ratePerSec` tokens refill continuously up to `burst`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private ratePerSec: number,
    private burst: number,
    private now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
  }

  take(n = 1): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /**
   * Reserves a token and returns how long to wait before using it (0 = now).
   * Lets callers apply backpressure (delay) instead of rejecting. Returns -1,
   * reserving nothing, if the wait would exceed `maxWaitMs`.
   */
  reserve(maxWaitMs: number): number {
    this.refill();
    const waitMs = this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.ratePerSec) * 1000;
    if (waitMs > maxWaitMs) return -1;
    this.tokens -= 1;
    return Math.ceil(waitMs);
  }
}

/** Allows one event per key per interval; used to throttle typing indicators. */
export class Throttle {
  private seen = new Map<string, number>();

  constructor(private intervalMs: number, private now: () => number = Date.now) {}

  allow(key: string): boolean {
    const t = this.now();
    const prev = this.seen.get(key);
    if (prev !== undefined && t - prev < this.intervalMs) return false;
    this.seen.set(key, t);
    if (this.seen.size > 10_000) this.prune(t);
    return true;
  }

  private prune(t: number) {
    for (const [k, v] of this.seen) if (t - v >= this.intervalMs) this.seen.delete(k);
  }
}
