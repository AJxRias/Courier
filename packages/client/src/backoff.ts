/**
 * Exponential backoff with "full jitter": each delay is uniform in
 * [0, min(max, base * 2^attempt)]. Spreading reconnects randomly is what stops
 * thousands of clients from hammering the servers in lockstep after an outage.
 */
export class Backoff {
  private attempt = 0;

  constructor(
    private baseMs = 500,
    private maxMs = 30_000,
    private random: () => number = Math.random,
  ) {}

  next(): number {
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    return Math.floor(this.random() * ceiling);
  }

  reset(): void {
    this.attempt = 0;
  }

  get attempts(): number {
    return this.attempt;
  }
}
