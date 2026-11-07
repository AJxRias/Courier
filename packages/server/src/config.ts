import { randomBytes } from "node:crypto";

export interface Config {
  /** Unique id for this gateway process; shows up in logs, metrics and `ready`. */
  nodeId: string;
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  /** Access-token lifetime issued by the dev login endpoint. */
  tokenTtlSec: number;
  /** Enables POST /auth/dev-login (username-only login). Never enable in production. */
  allowDevLogin: boolean;
  /** Browser origins allowed to open a socket. Empty = allow any. */
  allowedOrigins: string[];
  /** WebSocket ping interval; a socket that misses one pong is terminated. */
  heartbeatMs: number;
  /** Disconnect a client whose unsent buffer grows past this many bytes. */
  maxBufferedBytes: number;
  /** Per-connection send rate (messages/sec) and burst. */
  sendRatePerSec: number;
  sendBurst: number;
  /** Per-connection rate for all frames, enforced by disconnecting. */
  frameRatePerSec: number;
  frameBurst: number;
  /** How long a drain spreads client reconnects over. */
  drainWindowMs: number;
  /** Outbox rows older than this are re-published by the sweeper. */
  outboxGraceMs: number;
  outboxSweepMs: number;
  logLevel: string;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var ${name}`);
  return v;
}

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const isProd = process.env.NODE_ENV === "production";
  const jwtSecret = process.env.JWT_SECRET ?? (isProd ? undefined : "dev-only-secret-change-me-0123456789");
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be set and at least 32 characters");
  }
  return {
    nodeId: process.env.NODE_ID ?? `gw-${randomBytes(3).toString("hex")}`,
    host: env("HOST", "0.0.0.0"),
    port: num("PORT", 8080),
    databaseUrl: env("DATABASE_URL", "postgres://postgres@127.0.0.1:5432/chat"),
    redisUrl: env("REDIS_URL", "redis://127.0.0.1:6379"),
    jwtSecret,
    tokenTtlSec: num("TOKEN_TTL_SEC", 15 * 60),
    allowDevLogin: (process.env.ALLOW_DEV_LOGIN ?? (isProd ? "false" : "true")) === "true",
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    heartbeatMs: num("HEARTBEAT_MS", 25_000),
    maxBufferedBytes: num("MAX_BUFFERED_BYTES", 1024 * 1024),
    sendRatePerSec: num("SEND_RATE_PER_SEC", 10),
    sendBurst: num("SEND_BURST", 30),
    frameRatePerSec: num("FRAME_RATE_PER_SEC", 50),
    frameBurst: num("FRAME_BURST", 200),
    drainWindowMs: num("DRAIN_WINDOW_MS", 10_000),
    outboxGraceMs: num("OUTBOX_GRACE_MS", 2_000),
    outboxSweepMs: num("OUTBOX_SWEEP_MS", 1_000),
    logLevel: env("LOG_LEVEL", "info"),
    ...overrides,
  };
}
