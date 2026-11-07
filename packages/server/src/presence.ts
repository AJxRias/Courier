import type { Redis } from "ioredis";

/**
 * Presence and connection registry in Redis.
 *
 * Each user has a sorted set `presence:{userId}` whose members are
 * `{nodeId}:{sessionId}` and whose scores are expiry timestamps. A user is
 * online while any member is unexpired. Nodes refresh their sessions on every
 * heartbeat, so a crashed node's sessions age out on their own. Nothing here
 * touches Postgres.
 */
export class Presence {
  constructor(
    private redis: Redis,
    private nodeId: string,
    private ttlMs: number,
  ) {}

  private key(userId: string) {
    return `presence:${userId}`;
  }

  /** Registers a session; returns true if the user just came online. */
  async connect(userId: string, sessionId: string): Promise<boolean> {
    const now = Date.now();
    const key = this.key(userId);
    const res = await this.redis
      .multi()
      .zremrangebyscore(key, "-inf", now)
      .zcard(key)
      .zadd(key, now + this.ttlMs, `${this.nodeId}:${sessionId}`)
      .pexpire(key, this.ttlMs * 2)
      .exec();
    const before = Number(res?.[1]?.[1] ?? 0);
    return before === 0;
  }

  /** Removes a session; returns true if the user just went offline. */
  async disconnect(userId: string, sessionId: string): Promise<boolean> {
    const now = Date.now();
    const key = this.key(userId);
    const res = await this.redis
      .multi()
      .zrem(key, `${this.nodeId}:${sessionId}`)
      .zremrangebyscore(key, "-inf", now)
      .zcard(key)
      .exec();
    const removed = Number(res?.[0]?.[1] ?? 0);
    const after = Number(res?.[2]?.[1] ?? 0);
    return removed === 1 && after === 0;
  }

  /** Extends the TTL of every live session on this node in one round trip. */
  async refresh(sessions: { userId: string; sessionId: string }[]): Promise<void> {
    if (!sessions.length) return;
    const exp = Date.now() + this.ttlMs;
    const p = this.redis.pipeline();
    for (const s of sessions) {
      p.zadd(this.key(s.userId), "XX", exp, `${this.nodeId}:${s.sessionId}`);
      p.pexpire(this.key(s.userId), this.ttlMs * 2);
    }
    await p.exec();
  }

  async online(userIds: string[]): Promise<Record<string, boolean>> {
    if (!userIds.length) return {};
    const now = Date.now();
    const p = this.redis.pipeline();
    for (const id of userIds) p.zcount(this.key(id), now, "+inf");
    const res = await p.exec();
    return Object.fromEntries(userIds.map((id, i) => [id, Number(res?.[i]?.[1] ?? 0) > 0]));
  }
}
