import type { ChatMessage } from "@courier/protocol";
import { describe, expect, it } from "vitest";
import { Backoff } from "../src/backoff.js";
import { Sequencer } from "../src/sequencer.js";

const conv = "c1";
const msg = (seq: number, conversationId = conv): ChatMessage => ({
  conversationId,
  seq,
  id: `id-${seq}`,
  clientMsgId: `cm-${seq}`,
  senderId: "u",
  body: `m${seq}`,
  createdAt: new Date(0).toISOString(),
});

function setup(cursor = 0) {
  const out: number[] = [];
  const s = new Sequencer((m) => out.push(m.seq));
  s.init(conv, cursor);
  return { s, out };
}

describe("Sequencer", () => {
  it("delivers in order and drops duplicates", () => {
    const { s, out } = setup();
    s.push(msg(1));
    s.push(msg(1));
    s.push(msg(2));
    expect(out).toEqual([1, 2]);
  });

  it("holds out-of-order messages until the gap fills", () => {
    const { s, out } = setup();
    s.push(msg(3));
    s.push(msg(2));
    expect(out).toEqual([]);
    expect(s.hasHole(conv)).toBe(true);
    expect(s.push(msg(1))).toBe(3);
    expect(out).toEqual([1, 2, 3]);
    expect(s.behind(conv)).toBe(false);
  });

  it("ignores anything at or below the starting cursor", () => {
    const { s, out } = setup(10);
    s.push(msg(9));
    s.push(msg(10));
    s.push(msg(11));
    expect(out).toEqual([11]);
  });

  it("knows it is behind when the server advertises a higher seq", () => {
    const { s } = setup(5);
    s.advertise(conv, 8);
    expect(s.behind(conv)).toBe(true);
    expect(s.hasHole(conv)).toBe(false);
  });

  it("keeps conversations independent", () => {
    const out: string[] = [];
    const s = new Sequencer((m) => out.push(`${m.conversationId}:${m.seq}`));
    s.init("a", 0);
    s.init("b", 0);
    s.push(msg(2, "a"));
    s.push(msg(1, "b"));
    s.push(msg(1, "a"));
    expect(out).toEqual(["b:1", "a:1", "a:2"]);
  });

  it("property: any shuffle with duplicates yields exactly-once in-order delivery", () => {
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(Math.random() * 60);
      const stream: number[] = [];
      for (let i = 1; i <= n; i++) {
        const copies = 1 + Math.floor(Math.random() * 3);
        for (let c = 0; c < copies; c++) stream.push(i);
      }
      stream.sort(() => Math.random() - 0.5);
      const { s, out } = setup();
      for (const seq of stream) s.push(msg(seq));
      expect(out).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    }
  });
});

describe("Backoff", () => {
  it("grows exponentially up to the cap, with full jitter", () => {
    const ceilings: number[] = [];
    const b = new Backoff(100, 1000, () => 0.999999);
    for (let i = 0; i < 6; i++) ceilings.push(b.next());
    expect(ceilings).toEqual([99, 199, 399, 799, 999, 999]);
    b.reset();
    expect(b.next()).toBe(99);
    expect(new Backoff(100, 1000, () => 0).next()).toBe(0);
  });
});
