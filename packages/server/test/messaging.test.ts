import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  api,
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
  type Node,
  type User,
} from "./helpers.js";

let node: Node;
let alice: User, bob: User, carol: User;

beforeAll(async () => {
  await resetDb();
  node = await startNode({ sendRatePerSec: 1000, sendBurst: 1000 });
  [alice, bob, carol] = await Promise.all([login(node, "alice"), login(node, "bob"), login(node, "carol")]);
});
afterEach(closeClients);
afterAll(stopAll);

describe("messaging", () => {
  it("delivers messages to every member in order", async () => {
    const conv = await createConversation(node, alice, [bob, carol], "trio");
    const [a, b, c] = [connectClient(node.url, alice), connectClient(node.url, bob), connectClient(node.url, carol)];
    await Promise.all([ready(a), ready(b), ready(c)]);
    for (let i = 0; i < 20; i++) a.client.send(conv, `hello ${i}`);
    await waitFor(() => b.byConv(conv).length === 20 && c.byConv(conv).length === 20 && a.byConv(conv).length === 20);
    expect(b.byConv(conv)).toEqual(range(1, 20));
    expect(b.messages.map((m) => m.body)).toEqual(range(0, 19).map((i) => `hello ${i}`));
    expect(a.client.pending()).toEqual([]);
  });

  it("deduplicates retries of the same clientMsgId", async () => {
    const conv = await createConversation(node, alice, [bob]);
    const s = await RawSocket.authed(node.url, alice);
    const clientMsgId = randomUUID();
    // Fire the same send three times concurrently, then once more later.
    for (let i = 0; i < 3; i++) s.send({ t: "send", conversationId: conv, clientMsgId, body: "once" });
    const acks = [await s.next("sent"), await s.next("sent"), await s.next("sent")];
    s.send({ t: "send", conversationId: conv, clientMsgId, body: "once" });
    acks.push(await s.next("sent"));
    expect(new Set(acks.map((a) => a.seq))).toEqual(new Set([1]));
    expect(acks.filter((a) => !a.duplicate)).toHaveLength(1);
    const rows = await query("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1", [conv]);
    expect(rows[0].n).toBe(1);
    s.close();
  });

  it("assigns gapless seqs under concurrent writers and keeps each sender's order", async () => {
    const users = [alice, bob, carol];
    const conv = await createConversation(node, alice, [bob, carol]);
    const sockets = await Promise.all(users.flatMap((u) => [RawSocket.authed(node.url, u), RawSocket.authed(node.url, u)]));
    const perSocket = 50;
    sockets.forEach((s, si) => {
      for (let i = 0; i < perSocket; i++) s.send({ t: "send", conversationId: conv, clientMsgId: randomUUID(), body: `${si}:${i}` });
    });
    const total = sockets.length * perSocket;
    await waitFor(async () => (await query("SELECT last_seq FROM conversations WHERE id = $1", [conv]))[0].last_seq === total, 15_000);
    const rows = await query<{ seq: number; body: string }>("SELECT seq, body FROM messages WHERE conversation_id = $1 ORDER BY seq", [conv]);
    expect(rows.map((r) => r.seq)).toEqual(range(1, total));
    for (let si = 0; si < sockets.length; si++) {
      const mine = rows.filter((r) => r.body.startsWith(`${si}:`)).map((r) => Number(r.body.split(":")[1]));
      expect(mine).toEqual(range(0, perSocket - 1));
    }
    sockets.forEach((s) => s.close());
  });

  it("syncs read receipts to other members and to the reader's other devices", async () => {
    const conv = await createConversation(node, alice, [bob]);
    const a = connectClient(node.url, alice);
    const b1 = connectClient(node.url, bob);
    const b2 = connectClient(node.url, bob);
    await Promise.all([ready(a), ready(b1), ready(b2)]);
    a.client.send(conv, "one");
    a.client.send(conv, "two");
    await waitFor(() => b1.byConv(conv).length === 2);
    // Delivery receipts are sent automatically.
    await waitFor(() => a.events.some((e) => e.t === "receipt" && (e.data as any).kind === "delivered" && (e.data as any).seq === 2));
    b1.client.markRead(conv);
    const isRead = (e: { t: string; data: any }) => e.t === "receipt" && e.data.kind === "read" && e.data.userId === bob.id && e.data.seq === 2;
    await waitFor(() => a.events.some(isRead) && b2.events.some(isRead));
    const [row] = await query("SELECT read_seq, delivered_seq FROM conversation_members WHERE conversation_id = $1 AND user_id = $2", [conv, bob.id]);
    expect(row).toEqual({ read_seq: 2, delivered_seq: 2 });
    // Cursors never move backwards or past the end.
    b1.client.markRead(conv, 1);
    b1.client.markRead(conv, 999);
    await sleep(200);
    const [row2] = await query("SELECT read_seq FROM conversation_members WHERE conversation_id = $1 AND user_id = $2", [conv, bob.id]);
    expect(row2.read_seq).toBe(2);
  });

  it("shows typing to others (throttled) but not to the typist", async () => {
    const conv = await createConversation(node, alice, [bob]);
    const a = connectClient(node.url, alice);
    const b = connectClient(node.url, bob);
    await Promise.all([ready(a), ready(b)]);
    for (let i = 0; i < 5; i++) a.client.typing(conv);
    await waitFor(() => b.events.some((e) => e.t === "typing"));
    await sleep(200);
    expect(b.events.filter((e) => e.t === "typing")).toHaveLength(1);
    expect(a.events.filter((e) => e.t === "typing")).toHaveLength(0);
  });

  it("tracks presence across a user's devices", async () => {
    await createConversation(node, alice, [bob]);
    // Earlier tests' sockets close asynchronously; start from a clean slate.
    await waitFor(async () => !(await api(node.http, `/api/presence?userIds=${bob.id}`, { token: alice.token }))[bob.id], 10_000, "bob offline");
    const a = connectClient(node.url, alice);
    await ready(a);
    const presence = () => a.events.filter((e) => e.t === "presence" && (e.data as any).userId === bob.id).map((e) => (e.data as any).online);
    const b1 = connectClient(node.url, bob);
    await waitFor(() => presence().length === 1, 10_000, "online event");
    const b2 = connectClient(node.url, bob);
    await ready(b2);
    b1.client.close();
    await sleep(300);
    expect(presence()).toEqual([true]); // still online on the second device
    expect(await api(node.http, `/api/presence?userIds=${bob.id}`, { token: alice.token })).toEqual({ [bob.id]: true });
    b2.client.close();
    await waitFor(() => presence().length === 2, 10_000, "offline event");
    expect(presence()).toEqual([true, false]);
  });

  it("joins newly created conversations live, without reconnecting", async () => {
    const a = connectClient(node.url, alice);
    const c = connectClient(node.url, carol);
    await Promise.all([ready(a), ready(c)]);
    const conv = await createConversation(node, alice, [carol], "new room");
    await waitFor(() => c.events.some((e) => e.t === "joined"));
    a.client.send(conv, "welcome");
    await waitFor(() => c.byConv(conv).length === 1);

    // Adding someone to an existing conversation works the same way, and they
    // receive the history before they joined.
    const b = connectClient(node.url, bob);
    await ready(b);
    await api(node.http, `/api/conversations/${conv}/members`, { token: alice.token, body: { username: "bob" } });
    await waitFor(() => b.byConv(conv).length === 1);
    a.client.send(conv, "hi bob");
    await waitFor(() => b.byConv(conv).length === 2);
    expect(b.messages.filter((m) => m.conversationId === conv).map((m) => m.body)).toEqual(["welcome", "hi bob"]);
  });

  it("pages history backwards for scrollback", async () => {
    const conv = await createConversation(node, alice, [bob]);
    const a = connectClient(node.url, alice);
    await ready(a);
    for (let i = 1; i <= 30; i++) a.client.send(conv, `m${i}`);
    await waitFor(() => a.byConv(conv).length === 30);
    const latest = await api(node.http, `/api/conversations/${conv}/messages?limit=10`, { token: bob.token });
    expect(latest.map((m: any) => m.seq)).toEqual(range(21, 30));
    const older = await api(node.http, `/api/conversations/${conv}/messages?limit=10&before=21`, { token: bob.token });
    expect(older.map((m: any) => m.seq)).toEqual(range(11, 20));
  });
});
