import type { ChatMessage } from "@courier/protocol";

interface ConvState {
  /** Highest seq handed to the app; everything at or below it was delivered in order. */
  cursor: number;
  /** Highest seq we know exists on the server. */
  known: number;
  /** Out-of-order arrivals waiting for the gap below them to fill. */
  buffer: Map<number, ChatMessage>;
}

/**
 * Turns an at-least-once, possibly out-of-order stream (live fan-out, retries,
 * sync pages, duplicate publishes) into exactly-once, in-order delivery per
 * conversation. Pure logic with no I/O, so it's easy to test exhaustively.
 */
export class Sequencer {
  private states = new Map<string, ConvState>();

  constructor(private deliver: (msg: ChatMessage) => void) {}

  has(conversationId: string): boolean {
    return this.states.has(conversationId);
  }

  /** Starts tracking a conversation at `cursor` (no-op if already tracked). */
  init(conversationId: string, cursor: number): void {
    if (!this.states.has(conversationId)) {
      this.states.set(conversationId, { cursor, known: cursor, buffer: new Map() });
    }
  }

  cursor(conversationId: string): number {
    return this.states.get(conversationId)?.cursor ?? 0;
  }

  known(conversationId: string): number {
    return this.states.get(conversationId)?.known ?? 0;
  }

  /** Records that the server has messages up to `lastSeq`. */
  advertise(conversationId: string, lastSeq: number): void {
    const s = this.states.get(conversationId);
    if (s && lastSeq > s.known) s.known = lastSeq;
  }

  /** True when there are messages we know about but haven't delivered. */
  behind(conversationId: string): boolean {
    const s = this.states.get(conversationId);
    return !!s && s.known > s.cursor;
  }

  /** True when a later message is buffered behind a missing one. */
  hasHole(conversationId: string): boolean {
    const s = this.states.get(conversationId);
    return !!s && s.buffer.size > 0;
  }

  /** Returns the number of messages newly delivered as a result. */
  push(msg: ChatMessage): number {
    const s = this.states.get(msg.conversationId);
    if (!s) throw new Error(`untracked conversation ${msg.conversationId}`);
    if (msg.seq <= s.cursor || s.buffer.has(msg.seq)) return 0; // duplicate
    s.buffer.set(msg.seq, msg);
    if (msg.seq > s.known) s.known = msg.seq;
    let delivered = 0;
    for (let next = s.buffer.get(s.cursor + 1); next; next = s.buffer.get(s.cursor + 1)) {
      s.buffer.delete(next.seq);
      s.cursor = next.seq;
      delivered++;
      this.deliver(next);
    }
    return delivered;
  }

  conversations(): string[] {
    return [...this.states.keys()];
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.states].map(([id, s]) => [id, s.cursor]));
  }
}
