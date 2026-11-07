/**
 * Failure-mode tests. Each one breaks something real (kills a node, drops
 * fan-out, skips a publish, drops Redis) and asserts that every message still
 * reaches the application exactly once and in order.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeClients,
  connectClient,
  createConversation,
  login,
  query,
  range,
  RawSocket,
  ready,
  resetDb,
  sleep,
  startNode,
  stopAll,
  waitFor,
  type User,
} from "./helpers.js";

let alice: User, bob: User;

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  closeClients();
  await stopAll();
});
afterAll(stopAll);

async function twoNodes(faults?: Parameters<typeof startNode>[1]) {
  const n1 = await startNode({ nodeId: "n1", sendRatePerSec: 1000, sendBurst: 1000 });
  const n2 = await startNode({ nodeId: "n2", sendRatePerSec: 1000, sendBurst: 1000 }, faults);
  [alice, bob] = await Promise.all([login(n1, "alice"), login(n1, "bob")]);
  return { n1, n2 };
}

describe("resilience", () => {
  it("delivers across nodes", async () => {
    const { n1, n2 } = await twoNodes();
    const conv = await createConversation(n1, alice, [bob]);
    const a = connectClient(n1.url, alice);
    const b = connectClient(n2.url, bob);
    await Promise.all([ready(a), ready(b)]);
    for (let i = 0; i < 50; i++) a.client.send(conv, `x${i}`);
    await waitFor(() => b.byConv(conv).length === 50);
    expect(b.byConv(conv)).toEqual(range(1, 50));
  });

  it("loses nothing when the recipient's node crashes mid-stream", async () => {
    const { n1, n2 } = await twoNodes();
    const conv = await createConversation(n1, alice, [bob]);
    const a = connectClient(n1.url, alice);
    // Bob's client knows both nodes (stand-in for a load balancer) and starts on n2.
    const b = connectClient([n2.url, n1.url], bob);
    await Promise.all([ready(a), ready(b)]);

    const total = 300;
    let sent = 0;
    const sender = (async () => {
      while (sent < total) {
        a.client.send(conv, `m${++sent}`);
        if (sent % 10 === 0) await sleep(5);
      }
    })();
    await waitFor(() => b.byConv(conv).length >= 50, 10_000, "first messages");
    await n2.gw.crash();
    await sender;

    await waitFor(() => b.byConv(conv).length === total, 20_000, "all messages after crash");
    expect(b.byConv(conv)).toEqual(range(1, total));
    expect(b.messages.map((m) => m.body)).toEqual(range(1, total).map((i) => `m${i}`));
  });

  it("loses nothing (and creates no duplicates) when the sender's node crashes", async () => {
    const { n1, n2 } = await twoNodes();
    const conv = await createConversation(n1, alice, [bob]);
    const a = connectClient([n2.url, n1.url], alice);
    const b = connectClient(n1.url, bob);
    await Promise.all([ready(a), ready(b)]);
    const total = 200;
    for (let i = 1; i <= total; i++) a.client.send(conv, `m${i}`);
    await waitFor(() => b.byConv(conv).length >= 20);
    await n2.gw.crash(); // some sends are in flight, some unacked, some not yet sent
    await waitFor(() => b.byConv(conv).length === total, 20_000);
    expect(b.messages.map((m) => m.body)).toEqual(range(1, total).map((i) => `m${i}`));
    expect(a.client.pending()).toEqual([]);
    const [row] = await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1", [conv]);
    expect(row.n).toBe(total);
  });

  it("repairs gaps when pub/sub silently drops messages", async () => {
    // n2 drops every 3rd message it receives from Redis.
    const { n1, n2 } = await twoNodes({ dropBusEvent: (ev) => ev.k === "message" && ev.msg.seq % 3 === 0 });
    const conv = await createConversation(n1, alice, [bob]);
    const a = connectClient(n1.url, alice);
    const b = connectClient(n2.url, bob);
    await Promise.all([ready(a), ready(b)]);
    for (let i = 0; i < 61; i++) a.client.send(conv, `x${i}`);
    await waitFor(() => b.byConv(conv).length === 61);
    expect(b.byConv(conv)).toEqual(range(1, 61));
    expect(Number((await n2.gw.metrics.syncs.get()).values[0]?.value)).toBeGreaterThan(0);
  });

  it("repairs a single dropped message as soon as a later one reveals the gap", async () => {
    const { n1, n2 } = await twoNodes({ dropBusEvent: (ev) => ev.k === "message" && ev.msg.seq === 5 });
    const conv = await createConversation(n1, alice, [bob]);
    const a = connectClient(n1.url, alice);
    const b = connectClient(n2.url, bob);
    await Promise.all([ready(a), ready(b)]);
    for (let i = 0; i < 6; i++) a.client.send(conv, `x${i}`);
    await waitFor(() => b.byConv(conv).length === 6);
    expect(b.byConv(conv)).toEqual(range(1, 6));
  });

  it("delivers exactly once, in order, with 30% client-side loss and every message duplicated", async () => {
    const { n1 } = await twoNodes();
    const conv = await createConversation(n1, alice, [bob]);
    const a = connectClient(n1.url, alice);
    const b = connectClient(n1.url, bob);
    await Promise.all([ready(a), ready(b)]);
    b.client.setFaults({ dropRate: 0.3, duplicate: true });
    for (let i = 1; i <= 100; i++) a.client.send(conv, `f${i}`);
    await waitFor(() => b.byConv(conv).length === 100, 15_000);
    expect(b.byConv(conv)).toEqual(range(1, 100));
    const stats = b.client.stats;
    expect(stats.droppedSimulated).toBeGreaterThan(0);
    expect(stats.gapRepairs).toBeGreaterThan(0);
    expect(stats.duplicatesIgnored).toBeGreaterThan(0);
    expect(stats.delivered).toBe(100);
  });

  it("recovers from a simulated network drop and resends unacked messages", async () => {
    const { n1 } = await twoNodes();
    const conv = await createConversation(n1, alice, [bob]);
    const a = connectClient(n1.url, alice);
    const b = connectClient(n1.url, bob);
    await Promise.all([ready(a), ready(b)]);
    for (let i = 1; i <= 50; i++) a.client.send(conv, `d${i}`);
    a.client.dropConnection();
    await waitFor(() => b.byConv(conv).length === 50, 10_000);
    expect(b.byConv(conv)).toEqual(range(1, 50));
    expect(a.client.stats.reconnects).toBe(1);
  });

  it("publishes from the outbox when the post-commit publish never happens", async () => {
    const n1 = await startNode({ nodeId: "n1" }, { skipFastPathPublish: true });
    [alice, bob] = await Promise.all([login(n1, "alice"), login(n1, "bob")]);
    const conv = await createConversation(n1, alice, [bob]);
    // A raw socket never syncs, so the only way it sees the message is the sweeper.
    const watcher = await RawSocket.authed(n1.url, bob);
    const s = await RawSocket.authed(n1.url, alice);
    s.send({ t: "send", conversationId: conv, clientMsgId: randomUUID(), body: "via outbox" });
    await s.next("sent");
    const live = await watcher.next("message", undefined, 5000);
    expect(live.msg.body).toBe("via outbox");
    expect((await query("SELECT count(*)::int AS n FROM outbox"))[0].n).toBe(0);
    expect(Number((await n1.gw.metrics.outboxSwept.get()).values[0]?.value)).toBe(1);
    s.close();
    watcher.close();
  });

  it("tells clients to resync after the Redis subscriber reconnects", async () => {
    const { n1, n2 } = await twoNodes();
    const conv = await createConversation(n1, alice, [bob]);
    const a = connectClient(n1.url, alice);
    const b = connectClient(n2.url, bob);
    await Promise.all([ready(a), ready(b)]);
    a.client.send(conv, "before");
    await waitFor(() => b.byConv(conv).length === 1);

    // Drop n2's subscriber and publish while it's gone.
    n2.gw.bus.simulateDisconnect();
    a.client.send(conv, "during outage 1");
    a.client.send(conv, "during outage 2");
    await waitFor(() => b.byConv(conv).length === 3, 10_000);
    expect(b.messages.map((m) => m.body)).toEqual(["before", "during outage 1", "during outage 2"]);
  });

  it("queues sends while offline and flushes them in order on reconnect", async () => {
    const { n1, n2 } = await twoNodes();
    const conv = await createConversation(n1, alice, [bob]);
    const a = connectClient([n2.url, n1.url], alice);
    const b = connectClient(n1.url, bob);
    await Promise.all([ready(a), ready(b)]);
    const offline = new Promise<void>((resolve) => a.client.on("status", (st) => st === "offline" && resolve()));
    await n2.gw.crash();
    await offline;
    // Queued while disconnected; flushed once the client lands on n1.
    for (let i = 1; i <= 10; i++) a.client.send(conv, `offline ${i}`);
    expect(a.client.pending(conv)).toHaveLength(10);
    await waitFor(() => b.byConv(conv).length === 10, 10_000);
    expect(b.messages.map((m) => m.body)).toEqual(range(1, 10).map((i) => `offline ${i}`));
  });

  it("drains a node gracefully: clients move with no loss", async () => {
    const { n1, n2 } = await twoNodes();
    const conv = await createConversation(n1, alice, [bob]);
    const a = connectClient(n1.url, alice);
    const bobs = range(1, 5).map(() => connectClient([n2.url, n1.url], bob));
    await Promise.all([ready(a), ...bobs.map(ready)]);
    const drained = n2.gw.drain();
    for (let i = 1; i <= 100; i++) {
      a.client.send(conv, `d${i}`);
      if (i % 10 === 0) await sleep(20);
    }
    await drained;
    for (const b of bobs) {
      await waitFor(() => b.byConv(conv).length === 100, 15_000);
      expect(b.byConv(conv)).toEqual(range(1, 100));
    }
  });

  it("refuses new connections while draining", async () => {
    const { n2 } = await twoNodes();
    const b = connectClient(n2.url, bob);
    await ready(b);
    const drained = n2.gw.drain();
    await expect(RawSocket.open(n2.url)).rejects.toMatchObject({ status: 503 });
    b.client.close();
    await drained;
  });
});
