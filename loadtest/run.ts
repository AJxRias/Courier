/**
 * Load + chaos harness.
 *
 *   npm run loadtest -- --users 5000 --room-size 10 --rate 500 --duration 60 --spawn 2 --kill-at 30
 *
 * - Optionally spawns N gateway processes locally (--spawn) so it can SIGKILL
 *   one mid-run (--kill-at) and prove nothing is lost.
 * - Connects every user with the real client SDK, spread across gateways.
 * - Sends at a fixed total rate from random users into their rooms.
 * - Measures end-to-end latency (sender's send() call → recipient's app
 *   receives it) and verifies every client ends with every message exactly
 *   once, in order.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ChatClient, type SocketFactory } from "@courier/client";
import { WebSocket } from "ws";

const { values: args } = parseArgs({
  options: {
    users: { type: "string", default: "1000" },
    "room-size": { type: "string", default: "10" },
    rate: { type: "string", default: "200" },
    duration: { type: "string", default: "30" },
    spawn: { type: "string", default: "0" },
    "base-port": { type: "string", default: "9100" },
    url: { type: "string", default: "" },
    "kill-at": { type: "string", default: "" },
    "ramp-batch": { type: "string", default: "250" },
    out: { type: "string", default: "" },
  },
});

const USERS = Number(args.users);
const ROOM = Number(args["room-size"]);
const RATE = Number(args.rate);
const DURATION = Number(args.duration);
const SPAWN = Number(args.spawn);
const KILL_AT = args["kill-at"] ? Number(args["kill-at"]) : null;
const here = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ gateways

const procs: ChildProcess[] = [];
let bases: string[];

async function waitHealthy(base: string) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`gateway at ${base} never became healthy`);
}

if (SPAWN > 0) {
  const entry = join(here, "..", "packages", "server", "dist", "main.js");
  bases = [];
  for (let i = 0; i < SPAWN; i++) {
    const port = Number(args["base-port"]) + i;
    const p = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ID: `gw${i + 1}`,
        LOG_LEVEL: "warn",
        // Generous limits: the harness, not abuse protection, is under test here.
        FRAME_RATE_PER_SEC: "500",
        FRAME_BURST: "2000",
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    procs.push(p);
    bases.push(`http://127.0.0.1:${port}`);
  }
  await Promise.all(bases.map(waitHealthy));
  log(`spawned ${SPAWN} gateways`);
} else {
  bases = (args.url || "http://127.0.0.1:8080").split(",");
}
const wsUrls = bases.map((b) => b.replace(/^http/, "ws") + "/ws");

process.on("exit", () => procs.forEach((p) => p.kill("SIGKILL")));
process.on("SIGINT", () => process.exit(130));

// ------------------------------------------------------------------ setup

const run = Date.now().toString(36);
const api = async (path: string, token?: string, body?: unknown) => {
  const res = await fetch(bases[0] + path, {
    method: body ? "POST" : "GET",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

log(`creating ${USERS} users`);
const users: { id: string; username: string; token: string }[] = await pool(
  Array.from({ length: USERS }, (_, i) => `lt${run}_${i}`),
  32,
  async (username) => {
    const r = await api("/api/auth/dev-login", undefined, { username });
    return { ...r.user, token: r.token };
  },
);

const rooms: { id: string; members: number[] }[] = [];
const roomOf: number[] = [];
for (let i = 0; i < USERS; i += ROOM) {
  const members = Array.from({ length: Math.min(ROOM, USERS - i) }, (_, k) => i + k);
  rooms.push({ id: "", members });
  for (const m of members) roomOf[m] = rooms.length - 1;
}
log(`creating ${rooms.length} rooms of ${ROOM}`);
await pool(rooms, 16, async (room) => {
  const [owner, ...rest] = room.members.map((m) => users[m]!);
  const r = await api("/api/conversations", owner!.token, { members: rest.map((u) => u.username), title: `room ${run}` });
  room.id = r.id;
});

// ------------------------------------------------------------------ clients

const latencies: number[] = [];
const received: Map<string, number[]>[] = []; // per user: conv -> seqs
let reconnects = 0;
let sendFailures = 0;
const clients: ChatClient[] = [];

log(`connecting ${USERS} clients across ${wsUrls.length} gateway(s)`);
const t0 = Date.now();
const ramp = Number(args["ramp-batch"]);
for (let start = 0; start < USERS; start += ramp) {
  const batch = users.slice(start, start + ramp);
  await Promise.all(
    batch.map(
      (u, k) =>
        new Promise<void>((resolve) => {
          const idx = start + k;
          const perConv = new Map<string, number[]>();
          received[idx] = perConv;
          // Rotate the URL list per client so each starts on a different node,
          // and fails over to the others (stand-in for a load balancer).
          const offset = idx % wsUrls.length;
          const urls = [...wsUrls.slice(offset), ...wsUrls.slice(0, offset)];
          const c = new ChatClient({
            url: urls,
            getToken: () => u.token,
            WebSocket: WebSocket as unknown as SocketFactory,
            backfill: 0,
            backoff: { baseMs: 250, maxMs: 5000 },
            ackTimeoutMs: 15_000,
          });
          let readyOnce = false;
          c.on("ready", () => {
            if (readyOnce) reconnects++;
            readyOnce = true;
            resolve();
          });
          c.on("send_failed", () => sendFailures++);
          c.on("message", (m) => {
            let list = perConv.get(m.conversationId);
            if (!list) perConv.set(m.conversationId, (list = []));
            list.push(m.seq);
            if (m.senderId !== u.id) {
              const sentAt = Number(m.body.slice(0, m.body.indexOf("|")));
              if (sentAt) latencies.push(Date.now() - sentAt);
            }
          });
          c.connect();
          clients[idx] = c;
        }),
    ),
  );
}
log(`connected in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ------------------------------------------------------------------ traffic

let sent = 0;
const sentPerRoom = new Map<string, number>();
let killedAt: number | null = null;
const tickMs = 10;
const perTick = (RATE * tickMs) / 1000;
let carry = 0;
const start = Date.now();
log(`sending ${RATE} msg/s for ${DURATION}s${KILL_AT !== null ? `, killing gw1 at ${KILL_AT}s` : ""}`);

await new Promise<void>((resolve) => {
  const timer = setInterval(() => {
    const elapsed = (Date.now() - start) / 1000;
    if (elapsed >= DURATION) {
      clearInterval(timer);
      return resolve();
    }
    if (KILL_AT !== null && killedAt === null && elapsed >= KILL_AT && procs[0]) {
      procs[0].kill("SIGKILL");
      killedAt = elapsed;
      log(`SIGKILLed gw1 at ${elapsed.toFixed(1)}s`);
    }
    carry += perTick;
    while (carry >= 1) {
      carry--;
      const who = Math.floor(Math.random() * USERS);
      const room = rooms[roomOf[who]!]!;
      if (room.members.length < 2) continue;
      clients[who]!.send(room.id, `${Date.now()}|${who}|${sent}`);
      sentPerRoom.set(room.id, (sentPerRoom.get(room.id) ?? 0) + 1);
      sent++;
    }
    if (Math.floor(elapsed) !== Math.floor(elapsed - tickMs / 1000) && Math.floor(elapsed) % 5 === 0) {
      log(`t=${Math.floor(elapsed)}s sent=${sent} delivered=${latencies.length} p99=${pct(latencies, 99)}ms`);
    }
  }, tickMs);
});

// ------------------------------------------------------------------ verify

log("traffic stopped; waiting for every client to converge");
const expected = (idx: number) => sentPerRoom.get(rooms[roomOf[idx]!]!.id) ?? 0;
const converged = () => clients.every((c, idx) => (received[idx]!.get(rooms[roomOf[idx]!]!.id)?.length ?? 0) >= expected(idx));
const convergeStart = Date.now();
while (!converged() && Date.now() - convergeStart < 60_000) await sleep(200);
const convergeMs = Date.now() - convergeStart;

let missing = 0;
let duplicates = 0;
let outOfOrder = 0;
for (let idx = 0; idx < USERS; idx++) {
  const seqs = received[idx]!.get(rooms[roomOf[idx]!]!.id) ?? [];
  const want = expected(idx);
  duplicates += seqs.length - new Set(seqs).size;
  for (let i = 1; i < seqs.length; i++) if (seqs[i]! <= seqs[i - 1]!) outOfOrder++;
  missing += Math.max(0, want - new Set(seqs).size);
}
const pending = clients.reduce((n, c) => n + c.pending().length, 0);

latencies.sort((a, b) => a - b);
const result = {
  date: new Date().toISOString(),
  machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30) },
  config: { users: USERS, roomSize: ROOM, rooms: rooms.length, ratePerSec: RATE, durationSec: DURATION, gateways: wsUrls.length, killAtSec: KILL_AT },
  sent,
  deliveries: latencies.length,
  latencyMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99), max: latencies.at(-1) ?? null },
  correctness: { missing, duplicates, outOfOrder, unackedSends: pending, sendFailures },
  reconnects,
  killedAtSec: killedAt,
  convergeMs,
};
console.log(JSON.stringify(result, null, 2));
if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));

for (const c of clients) c.close();
const ok = missing === 0 && duplicates === 0 && outOfOrder === 0 && pending === 0;
log(ok ? "PASS: every message delivered exactly once, in order" : "FAIL: delivery guarantees violated");
await sleep(200);
process.exit(ok ? 0 : 1);

// ------------------------------------------------------------------ utils

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const s = sorted === latencies && !isSorted(sorted) ? [...sorted].sort((a, b) => a - b) : sorted;
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

function isSorted(a: number[]): boolean {
  for (let i = 1; i < a.length; i++) if (a[i]! < a[i - 1]!) return false;
  return true;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string) {
  console.error(`[loadtest ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
