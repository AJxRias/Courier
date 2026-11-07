import { randomUUID } from "node:crypto";
import { CloseCode } from "@courier/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Auth } from "../src/auth.js";
import { api, createConversation, login, RawSocket, resetDb, startNode, stopAll, type Node, type User } from "./helpers.js";

let node: Node;
let alice: User, bob: User, eve: User;
let conv: string;

beforeAll(async () => {
  await resetDb();
  node = await startNode({ allowedOrigins: ["https://chat.example"], sendRatePerSec: 2, sendBurst: 5 });
  [alice, bob, eve] = await Promise.all([login(node, "alice"), login(node, "bob"), login(node, "eve")]);
  conv = await createConversation(node, alice, [bob]);
});
afterAll(stopAll);

describe("authentication", () => {
  it("rejects frames before auth", async () => {
    const s = await RawSocket.open(node.url);
    s.send({ t: "ping", ts: 1 });
    expect((await s.waitClosed()).code).toBe(CloseCode.AuthFailed);
  });

  it("rejects a bad token", async () => {
    const s = await RawSocket.open(node.url);
    s.send({ t: "auth", token: "nope", deviceId: "d", v: 1 });
    expect((await s.waitClosed()).code).toBe(CloseCode.AuthFailed);
  });

  it("rejects a token signed with another key", async () => {
    const forged = await new Auth("x".repeat(40), 60).issue(alice.id, "alice");
    const s = await RawSocket.open(node.url);
    s.send({ t: "auth", token: forged, deviceId: "d", v: 1 });
    expect((await s.waitClosed()).code).toBe(CloseCode.AuthFailed);
  });

  it("closes sockets that never authenticate", async () => {
    const s = await RawSocket.open(node.url);
    expect((await s.waitClosed()).code).toBe(CloseCode.AuthTimeout);
  });

  it("closes the socket when the token expires", async () => {
    const shortLived = await node.gw.auth.issue(alice.id, "alice", 1);
    const s = await RawSocket.open(node.url);
    s.send({ t: "auth", token: shortLived, deviceId: "d", v: 1 });
    await s.next("ready");
    expect((await s.waitClosed(4000)).code).toBe(CloseCode.TokenExpired);
  });

  it("refuses browser origins that aren't allowed", async () => {
    await expect(RawSocket.open(node.url, { origin: "https://evil.example" })).rejects.toMatchObject({ status: 403 });
    const ok = await RawSocket.open(node.url, { origin: "https://chat.example" });
    ok.close();
  });

  it("protects REST endpoints", async () => {
    await expect(api(node.http, "/api/conversations")).rejects.toMatchObject({ status: 401 });
  });
});

describe("authorization", () => {
  it("won't let a non-member send, sync or read history", async () => {
    const s = await RawSocket.authed(node.url, eve);
    const clientMsgId = randomUUID();
    s.send({ t: "send", conversationId: conv, clientMsgId, body: "hi" });
    const err = await s.next("error", (f) => f.clientMsgId === clientMsgId);
    expect(err).toMatchObject({ code: "forbidden", retryable: false });

    s.send({ t: "sync", reqId: "r1", conversationId: conv, afterSeq: 0 });
    expect(await s.next("error", (f) => f.reqId === "r1")).toMatchObject({ code: "forbidden" });

    await expect(api(node.http, `/api/conversations/${conv}/messages`, { token: eve.token })).rejects.toMatchObject({ status: 403 });
    await expect(
      api(node.http, `/api/conversations/${conv}/members`, { token: eve.token, body: { username: "eve" } }),
    ).rejects.toMatchObject({ status: 403 });
    s.close();
  });
});

describe("input validation and limits", () => {
  it("rejects malformed frames without dropping the connection", async () => {
    const s = await RawSocket.authed(node.url, alice);
    s.send("{not json");
    expect(await s.next("error")).toMatchObject({ code: "bad_request" });
    s.send({ t: "send", conversationId: "not-a-uuid", clientMsgId: randomUUID(), body: "x" });
    expect(await s.next("error")).toMatchObject({ code: "bad_request" });
    s.send({ t: "send", conversationId: conv, clientMsgId: randomUUID(), body: "x".repeat(4001) });
    expect(await s.next("error")).toMatchObject({ code: "bad_request" });
    s.send({ t: "ping", ts: 42 });
    expect(await s.next("pong")).toMatchObject({ ts: 42 });
    s.close();
  });

  it("drops frames larger than the limit", async () => {
    const s = await RawSocket.authed(node.url, alice);
    s.send({ t: "ping", ts: 1, pad: "x".repeat(20_000) });
    expect((await s.waitClosed()).code).toBe(CloseCode.TooBig);
  });

  it("applies backpressure over the send rate: delays, never drops or reorders", async () => {
    // Limit is 2/s with a burst of 5, so sends 6..9 wait ~0.5s each.
    const s = await RawSocket.authed(node.url, alice);
    const ids = Array.from({ length: 9 }, () => randomUUID());
    const t0 = Date.now();
    ids.forEach((clientMsgId, i) => s.send({ t: "send", conversationId: conv, clientMsgId, body: `bp${i}` }));
    const acks = [];
    for (const id of ids) acks.push(await s.next("sent", (f) => f.clientMsgId === id, 8000));
    const seqs = acks.map((a) => a.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(Date.now() - t0).toBeGreaterThan(1500);
    expect(s.frames.some((f) => f.t === "error")).toBe(false);
    s.close();
  });

  it("disconnects a client that queues far more sends than the window allows", async () => {
    const s = await RawSocket.authed(node.url, alice);
    for (let i = 0; i < 150; i++) s.send({ t: "send", conversationId: conv, clientMsgId: randomUUID(), body: `q${i}` });
    expect((await s.waitClosed()).code).toBe(CloseCode.RateLimited);
  });

  it("disconnects clients that flood frames", async () => {
    const s = await RawSocket.authed(node.url, alice);
    for (let i = 0; i < 400; i++) s.send({ t: "ping", ts: i });
    expect((await s.waitClosed()).code).toBe(CloseCode.RateLimited);
  });

  it("strips control characters and rejects blank bodies", async () => {
    const s = await RawSocket.authed(node.url, bob);
    const id1 = randomUUID();
    s.send({ t: "send", conversationId: conv, clientMsgId: id1, body: "he\u0000llo\u0007" });
    await s.next("sent", (f) => f.clientMsgId === id1);
    const hist = await api(node.http, `/api/conversations/${conv}/messages`, { token: bob.token });
    expect(hist.at(-1).body).toBe("hello");
    const id2 = randomUUID();
    s.send({ t: "send", conversationId: conv, clientMsgId: id2, body: "\u0000\u0001" });
    expect(await s.next("error", (f) => f.clientMsgId === id2)).toMatchObject({ code: "bad_request" });
    s.close();
  });
});
