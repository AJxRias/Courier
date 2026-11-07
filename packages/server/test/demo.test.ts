import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api, closeClients, connectClient, login, ready, resetDb, startNode, stopAll, waitFor, type Node } from "./helpers.js";

let node: Node;

beforeAll(async () => {
  await resetDb();
  node = await startNode({ demoBots: true, sendRatePerSec: 100, sendBurst: 100 });
});
afterEach(closeClients);
afterAll(stopAll);

const isBot = (c: any, name: string) => c.members.some((m: any) => m.username === name && m.isBot);

describe("demo bots", () => {
  it("onboards a new user with a guide DM and a demo room, and the bots talk", async () => {
    const visitor = await login(node, "visitor");
    const convs = await api(node.http, "/api/conversations", { token: visitor.token });
    const dm = convs.find((c: any) => c.kind === "direct" && isBot(c, "guide_bot"));
    const room = convs.find((c: any) => c.title === "Demo room");
    expect(dm).toBeTruthy();
    expect(room && isBot(room, "maya_bot") && isBot(room, "theo_bot")).toBe(true);

    const v = connectClient(node.url, visitor);
    await ready(v);
    // Welcome script: three lines from the guide, two from the room bots, each after typing.
    await waitFor(() => v.byConv(dm.id).length === 3 && v.byConv(room.id).length === 2, 20_000, "welcome messages");
    expect(v.events.some((e) => e.t === "typing")).toBe(true);

    v.client.send(dm.id, "hello there");
    await waitFor(() => v.messages.some((m) => m.conversationId === dm.id && m.body.includes("#4")), 10_000, "guide reply");
    await waitFor(
      () => v.events.some((e) => e.t === "receipt" && (e.data as any).kind === "read" && (e.data as any).conversationId === dm.id),
      5000,
      "read receipt",
    );

    const before = v.byConv(dm.id).length;
    v.client.send(dm.id, "/burst 30");
    await waitFor(() => v.messages.filter((m) => m.body.endsWith("of 30")).length === 30, 15_000, "burst");
    const bursts = v.messages.filter((m) => m.body.endsWith("of 30")).map((m) => m.body);
    expect(bursts).toEqual(Array.from({ length: 30 }, (_, i) => `Burst ${i + 1} of 30`));
    expect(v.byConv(dm.id).length).toBe(before + 1 + 30);

    v.client.send(room.id, "hi everyone");
    await waitFor(() => v.messages.some((m) => m.conversationId === room.id && m.seq > 3 && m.senderId !== visitor.id), 10_000, "room reply");
  });

  it("is idempotent and keeps bots out of user-made conversations", async () => {
    const u = await login(node, "second_visitor");
    const first = await api(node.http, "/api/demo/start", { token: u.token, body: {} });
    const again = await api(node.http, "/api/demo/start", { token: u.token, body: {} });
    expect(again).toEqual(first);

    await expect(api(node.http, "/api/auth/dev-login", { body: { username: "guide_bot" } })).rejects.toMatchObject({ status: 403 });
    await expect(api(node.http, "/api/conversations", { token: u.token, body: { members: ["maya_bot"] } })).rejects.toMatchObject({ status: 403 });
    const search = await api(node.http, "/api/users?q=", { token: u.token });
    expect(search.some((s: any) => s.username.endsWith("_bot"))).toBe(false);
  });
});
