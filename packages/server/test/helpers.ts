import { ChatClient, type ChatClientOptions, type ChatMessage } from "@courier/client";
import type { ServerFrame } from "@courier/protocol";
import { Redis } from "ioredis";
import pg from "pg";
import pino from "pino";
import { WebSocket } from "ws";
import { loadConfig, type Config } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { Gateway, type Faults } from "../src/gateway.js";

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/chat_test";
export const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/1";

let migrated = false;

export async function resetDb(): Promise<void> {
  const db = createPool(DATABASE_URL, 1);
  try {
    if (!migrated) {
      await migrate(db);
      migrated = true;
    }
    await db.query("TRUNCATE users, conversations, conversation_members, messages, outbox RESTART IDENTITY CASCADE");
    const redis = new Redis(REDIS_URL);
    await redis.flushdb();
    redis.disconnect();
  } finally {
    await db.end();
  }
}

export interface Node {
  gw: Gateway;
  url: string;
  http: string;
}

const running = new Set<Gateway>();

export async function startNode(config: Partial<Config> = {}, faults?: Faults): Promise<Node> {
  const gw = new Gateway({
    config: loadConfig({
      port: 0,
      host: "127.0.0.1",
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      heartbeatMs: 2000,
      outboxGraceMs: 300,
      outboxSweepMs: 200,
      drainWindowMs: 500,
      allowDevLogin: true,
      ...config,
    }),
    logger: pino({ level: process.env.TEST_LOG ?? "silent" }),
    runMigrations: false,
    faults,
  });
  const { port } = await gw.start();
  running.add(gw);
  return { gw, url: `ws://127.0.0.1:${port}/ws`, http: `http://127.0.0.1:${port}` };
}

export async function stopAll(): Promise<void> {
  await Promise.allSettled([...running].map((gw) => gw.stop()));
  running.clear();
}

export async function api<T = any>(base: string, path: string, opts: { token?: string; body?: unknown; method?: string } = {}): Promise<T> {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error ?? res.statusText), { status: res.status });
  return json as T;
}

export interface User {
  id: string;
  username: string;
  token: string;
}

export async function login(node: Node, username: string): Promise<User> {
  const r = await api(node.http, "/api/auth/dev-login", { body: { username } });
  return { ...r.user, token: r.token };
}

export async function createConversation(node: Node, owner: User, members: User[], title?: string): Promise<string> {
  const r = await api(node.http, "/api/conversations", {
    token: owner.token,
    body: { members: members.map((m) => m.username), title },
  });
  return r.id;
}

export interface TestClient {
  client: ChatClient;
  messages: ChatMessage[];
  events: { t: string; data: unknown }[];
  byConv(id: string): number[];
}

const clients = new Set<ChatClient>();

export function connectClient(urls: string | string[], user: User, opts: Partial<ChatClientOptions> = {}): TestClient {
  const client = new ChatClient({
    url: urls,
    getToken: () => user.token,
    backoff: { baseMs: 50, maxMs: 500 },
    gapGraceMs: 100,
    ackTimeoutMs: 2000,
    backfill: 1000,
    ...opts,
  });
  const messages: ChatMessage[] = [];
  const events: { t: string; data: unknown }[] = [];
  client.on("message", (m) => messages.push(m));
  for (const t of ["receipt", "typing", "presence", "joined", "send_failed", "sent"] as const) {
    client.on(t, (data: unknown) => events.push({ t, data }));
  }
  client.connect();
  clients.add(client);
  return { client, messages, events, byConv: (id) => messages.filter((m) => m.conversationId === id).map((m) => m.seq) };
}

export function closeClients(): void {
  for (const c of clients) c.close();
  clients.clear();
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export async function ready(tc: TestClient): Promise<void> {
  await waitFor(() => tc.client.status === "ready", 10_000, "client ready");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Low-level socket for protocol tests that bypass the SDK. */
export class RawSocket {
  frames: ServerFrame[] = [];
  closed: { code: number; reason: string } | null = null;
  ws: WebSocket;

  private constructor(url: string, headers?: Record<string, string>) {
    this.ws = new WebSocket(url, { headers });
    this.ws.on("message", (d) => this.frames.push(JSON.parse(d.toString())));
    this.ws.on("close", (code, reason) => (this.closed = { code, reason: reason.toString() }));
    this.ws.on("error", () => {});
  }

  static async open(url: string, headers?: Record<string, string>): Promise<RawSocket> {
    const s = new RawSocket(url, headers);
    await new Promise<void>((resolve, reject) => {
      s.ws.once("open", () => resolve());
      s.ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error("rejected"), { status: res.statusCode })));
      s.ws.once("error", reject);
    });
    return s;
  }

  static async authed(url: string, user: User): Promise<RawSocket> {
    const s = await RawSocket.open(url);
    s.send({ t: "auth", token: user.token, deviceId: "raw", v: 1 });
    await s.next("ready");
    return s;
  }

  send(frame: unknown): void {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  async next<T extends ServerFrame["t"]>(t: T, pred: (f: Extract<ServerFrame, { t: T }>) => boolean = () => true, timeoutMs = 5000) {
    let found: Extract<ServerFrame, { t: T }> | undefined;
    await waitFor(
      () => {
        const i = this.frames.findIndex((f) => f.t === t && pred(f as Extract<ServerFrame, { t: T }>));
        if (i === -1) return false;
        found = this.frames.splice(i, 1)[0] as Extract<ServerFrame, { t: T }>;
        return true;
      },
      timeoutMs,
      `frame ${t}`,
    );
    return found!;
  }

  async waitClosed(timeoutMs = 7000) {
    await waitFor(() => this.closed !== null, timeoutMs, "socket close");
    return this.closed!;
  }

  close(): void {
    this.ws.close();
  }
}

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}
