import type { BusEvent } from "@courier/protocol";
import { Redis } from "ioredis";
import type { Logger } from "pino";

type Handler = (channel: string, event: BusEvent) => void;

/**
 * Redis pub/sub wrapper used for cross-node fan-out.
 *
 * - Each node subscribes only to channels its connected users need
 *   (per-conversation and per-user), reference counted.
 * - Unsubscribes linger briefly so a reconnecting client doesn't cause
 *   subscribe/unsubscribe churn.
 * - Subscribe/unsubscribe for a channel are chained so they apply in order.
 *
 * Pub/sub is fire-and-forget: this bus is the *fast path* only. Correctness comes
 * from per-conversation seq numbers, which let clients detect and repair gaps,
 * plus the transactional outbox for publishes that never happened.
 */
export class Bus {
  readonly pub: Redis;
  private sub: Redis;
  private refs = new Map<string, number>();
  private wanted = new Set<string>();
  private chains = new Map<string, Promise<unknown>>();
  private lingerTimers = new Map<string, NodeJS.Timeout>();
  private everReady = false;

  constructor(
    url: string,
    private log: Logger,
    private onEvent: Handler,
    private onReconnect: () => void,
    private lingerMs = 30_000,
  ) {
    const opts = { maxRetriesPerRequest: null, enableAutoPipelining: true } as const;
    this.pub = new Redis(url, opts);
    this.sub = new Redis(url, { ...opts, enableAutoPipelining: false });
    this.sub.on("message", (channel: string, raw: string) => {
      let event: BusEvent;
      try {
        event = JSON.parse(raw) as BusEvent;
      } catch {
        this.log.warn({ channel }, "dropping malformed bus event");
        return;
      }
      this.onEvent(channel, event);
    });
    // ioredis re-subscribes automatically after a reconnect, but anything
    // published while we were disconnected is gone; tell the gateway so clients
    // can compare cursors and resync.
    this.sub.on("ready", () => {
      if (this.everReady) {
        this.log.warn("bus subscriber reconnected; requesting client resync");
        this.onReconnect();
      }
      this.everReady = true;
    });
    for (const c of [this.pub, this.sub]) c.on("error", (err) => this.log.error({ err: err.message }, "redis error"));
  }

  async ready(): Promise<void> {
    await Promise.all([this.pub.ping(), this.sub.ping()]);
  }

  /** Increments the channel's refcount; resolves once Redis confirms the subscription. */
  async acquire(channel: string): Promise<void> {
    this.refs.set(channel, (this.refs.get(channel) ?? 0) + 1);
    const timer = this.lingerTimers.get(channel);
    if (timer) {
      clearTimeout(timer);
      this.lingerTimers.delete(channel);
    }
    if (!this.wanted.has(channel)) {
      this.wanted.add(channel);
      return this.enqueue(channel, () => this.sub.subscribe(channel));
    }
    await this.chains.get(channel);
  }

  release(channel: string): void {
    const n = (this.refs.get(channel) ?? 0) - 1;
    if (n > 0) {
      this.refs.set(channel, n);
      return;
    }
    this.refs.delete(channel);
    if (this.lingerTimers.has(channel)) return;
    const timer = setTimeout(() => {
      this.lingerTimers.delete(channel);
      if (this.refs.has(channel) || !this.wanted.has(channel)) return;
      this.wanted.delete(channel);
      void this.enqueue(channel, () => this.sub.unsubscribe(channel)).catch(() => {});
    }, this.lingerMs);
    timer.unref();
    this.lingerTimers.set(channel, timer);
  }

  async publish(channel: string, event: BusEvent | unknown): Promise<void> {
    await this.pub.publish(channel, JSON.stringify(event));
  }

  subscribedCount(): number {
    return this.wanted.size;
  }

  private enqueue(channel: string, op: () => Promise<unknown>): Promise<void> {
    const prev = this.chains.get(channel) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(op);
    this.chains.set(channel, next);
    void next.finally(() => {
      if (this.chains.get(channel) === next) this.chains.delete(channel);
    }).catch(() => {});
    return next.then(() => undefined);
  }

  /** Test hook: force-drops the subscriber connection to simulate a Redis blip. */
  simulateDisconnect(): void {
    this.sub.disconnect(true);
  }

  async close(): Promise<void> {
    for (const t of this.lingerTimers.values()) clearTimeout(t);
    this.lingerTimers.clear();
    await Promise.allSettled([this.sub.quit(), this.pub.quit()]);
  }

  /** Hard stop without the QUIT handshake, used when simulating a crash. */
  kill(): void {
    for (const t of this.lingerTimers.values()) clearTimeout(t);
    this.sub.disconnect();
    this.pub.disconnect();
  }
}
