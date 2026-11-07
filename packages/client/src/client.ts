import type { ChatMessage, ConversationCursor, ErrorCode, ServerFrame } from "@courier/protocol";
import { CloseCode, PROTOCOL_VERSION } from "@courier/protocol";
import { Backoff } from "./backoff.js";
import { Emitter } from "./emitter.js";
import { Sequencer } from "./sequencer.js";
import { memoryStorage, type ClientStorage, type PendingSend } from "./storage.js";

/** The subset of the WebSocket API we use; satisfied by browsers, Node 22+ and the `ws` package. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketFactory = new (url: string) => SocketLike;

export type Status = "idle" | "connecting" | "authenticating" | "ready" | "offline" | "closed";

export interface ChatClientOptions {
  /** One URL behind a load balancer, or several to rotate through on reconnect. */
  url: string | string[];
  /** Called on every (re)connect, so it can return a freshly refreshed token. */
  getToken: () => Promise<string> | string;
  deviceId?: string;
  storage?: ClientStorage;
  WebSocket?: SocketFactory;
  /** How long to wait for a missing seq to arrive live before asking the server. */
  gapGraceMs?: number;
  /** If a send isn't acknowledged within this long, the link is presumed stuck and is reset. */
  ackTimeoutMs?: number;
  /** Sends pipelined before waiting for acks. The server processes them in order. */
  maxInFlight?: number;
  /** For a conversation this device has never seen, how many recent messages to fetch. */
  backfill?: number;
  backoff?: { baseMs?: number; maxMs?: number };
  /** Debounce for automatic "delivered" receipts. */
  deliveredAckMs?: number;
}

export interface ClientEvents extends Record<string, unknown[]> {
  status: [status: Status, detail?: { code?: number; reason?: string; retryInMs?: number }];
  ready: [info: { userId: string; nodeId: string; conversations: ConversationCursor[] }];
  /** Exactly once per message, in seq order within each conversation. */
  message: [msg: ChatMessage];
  sent: [info: { clientMsgId: string; conversationId: string; seq: number; duplicate: boolean }];
  send_failed: [info: { clientMsgId: string; conversationId: string; code: ErrorCode; message: string }];
  receipt: [info: { conversationId: string; userId: string; kind: "delivered" | "read"; seq: number }];
  typing: [info: { conversationId: string; userId: string }];
  presence: [info: { userId: string; online: boolean }];
  joined: [cursor: ConversationCursor];
  rtt: [ms: number];
  error: [info: { code: ErrorCode; message: string }];
}

type Outgoing = PendingSend;

const OPEN = 1;

export class ChatClient extends Emitter<ClientEvents> {
  readonly deviceId: string;
  private opts: Required<Omit<ChatClientOptions, "backoff" | "url" | "getToken" | "deviceId" | "storage" | "WebSocket">>;
  private urls: string[];
  private urlIndex = 0;
  private Socket: SocketFactory;
  private storage: ClientStorage;
  private backoff: Backoff;
  private ws: SocketLike | null = null;
  private _status: Status = "idle";
  private stopped = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private livenessTimer?: ReturnType<typeof setInterval>;
  private lastFrameAt = 0;
  private heartbeatMs = 25_000;
  private userId = "";
  /** Set when we close the socket on purpose and want to reconnect right away. */
  private skipBackoff = false;

  private seq: Sequencer;
  /** Insertion-ordered queue of unacknowledged sends. */
  private outbox = new Map<string, Outgoing>();
  private inFlight = new Set<string>();
  private ackTimer?: ReturnType<typeof setTimeout>;
  private gapTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private syncing = new Map<string, { reqId: string; timer: ReturnType<typeof setTimeout> }>();
  private reqCounter = 0;
  private storedCursors: Record<string, number>;
  private pendingDelivered = new Map<string, number>();
  private deliveredTimer?: ReturnType<typeof setTimeout>;
  private typingSentAt = new Map<string, number>();
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(private options: ChatClientOptions) {
    super();
    this.urls = Array.isArray(options.url) ? options.url : [options.url];
    const Socket = options.WebSocket ?? (globalThis as { WebSocket?: SocketFactory }).WebSocket;
    if (!Socket) throw new Error("No WebSocket implementation available; pass options.WebSocket");
    this.Socket = Socket;
    this.deviceId = options.deviceId ?? randomId();
    this.storage = options.storage ?? memoryStorage();
    this.backoff = new Backoff(options.backoff?.baseMs, options.backoff?.maxMs);
    this.opts = {
      gapGraceMs: options.gapGraceMs ?? 250,
      ackTimeoutMs: options.ackTimeoutMs ?? 10_000,
      maxInFlight: options.maxInFlight ?? 32,
      backfill: options.backfill ?? 50,
      deliveredAckMs: options.deliveredAckMs ?? 500,
    };
    this.seq = new Sequencer((msg) => this.onDeliver(msg));

    const snap = this.storage.load();
    this.storedCursors = snap?.cursors ?? {};
    for (const p of snap?.outbox ?? []) this.outbox.set(p.clientMsgId, p);
  }

  // ------------------------------------------------------------------ public API

  get status(): Status {
    return this._status;
  }

  get currentUserId(): string {
    return this.userId;
  }

  connect(): void {
    this.stopped = false;
    if (this.ws || this.reconnectTimer) return;
    this.open();
  }

  /** Closes for good (e.g. logout). Unsent messages stay in storage. */
  close(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.teardown();
    this.ws?.close(CloseCode.Normal, "client closed");
    this.ws = null;
    this.flushSave();
    this.setStatus("closed");
  }

  /** Skip the backoff wait, e.g. when the browser reports it's back online. */
  reconnectNow(): void {
    if (this.stopped || this._status === "ready" || this.ws) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.open();
  }

  /**
   * Queues a message and returns its clientMsgId immediately. It's delivered
   * when connected, retried until acknowledged, and survives reconnects (and
   * reloads, with persistent storage). Retries can never create duplicates,
   * and a sender's messages are stored in the order send() was called.
   */
  send(conversationId: string, body: string): string {
    const clientMsgId = randomUUID();
    this.outbox.set(clientMsgId, { clientMsgId, conversationId, body, createdAt: new Date().toISOString() });
    this.scheduleSave();
    this.pump();
    return clientMsgId;
  }

  /** Messages accepted by send() but not yet confirmed, oldest first. */
  pending(conversationId?: string): PendingSend[] {
    return [...this.outbox.values()]
      .filter((o) => !conversationId || o.conversationId === conversationId)
      .map(({ clientMsgId, conversationId, body, createdAt }) => ({ clientMsgId, conversationId, body, createdAt }));
  }

  /** Drops a failed or unwanted pending message. */
  discard(clientMsgId: string): void {
    if (this.inFlight.has(clientMsgId)) return; // already on the wire; can't be recalled
    if (this.outbox.delete(clientMsgId)) this.scheduleSave();
  }

  markRead(conversationId: string, seq = this.seq.cursor(conversationId)): void {
    if (seq > 0) this.raw({ t: "ack", conversationId, kind: "read", seq });
  }

  /** Throttled client-side too, so wiring this to every keystroke is fine. */
  typing(conversationId: string): void {
    const now = Date.now();
    if (now - (this.typingSentAt.get(conversationId) ?? 0) < 2000) return;
    this.typingSentAt.set(conversationId, now);
    this.raw({ t: "typing", conversationId });
  }

  /** Highest seq delivered to the app for a conversation. */
  cursor(conversationId: string): number {
    return this.seq.cursor(conversationId);
  }

  // ------------------------------------------------------------------ connection

  private open(): void {
    this.reconnectTimer = undefined;
    const url = this.urls[this.urlIndex++ % this.urls.length]!;
    this.setStatus("connecting");
    let ws: SocketLike;
    try {
      ws = new this.Socket(url);
    } catch {
      return this.scheduleReconnect();
    }
    this.ws = ws;

    ws.onopen = async () => {
      if (this.ws !== ws) return;
      this.setStatus("authenticating");
      try {
        const token = await this.options.getToken();
        if (this.ws !== ws || ws.readyState !== OPEN) return;
        ws.send(JSON.stringify({ t: "auth", token, deviceId: this.deviceId, v: PROTOCOL_VERSION }));
      } catch {
        ws.close(CloseCode.Normal, "token unavailable");
      }
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastFrameAt = Date.now();
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      let frame: ServerFrame;
      try {
        frame = JSON.parse(data) as ServerFrame;
      } catch {
        return;
      }
      this.onFrame(frame);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.teardown();
      if (this.stopped) return;
      const immediate = this.skipBackoff || ev.code === CloseCode.TokenExpired || ev.code === CloseCode.GoingAway;
      this.skipBackoff = false;
      this.scheduleReconnect(immediate ? 0 : undefined, ev);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(delay = this.backoff.next(), ev?: { code: number; reason: string }): void {
    if (this.stopped) return;
    this.setStatus("offline", { code: ev?.code, reason: ev?.reason, retryInMs: delay });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private teardown(): void {
    clearInterval(this.livenessTimer);
    for (const t of this.gapTimers.values()) clearTimeout(t);
    this.gapTimers.clear();
    for (const s of this.syncing.values()) clearTimeout(s.timer);
    this.syncing.clear();
    // Unacked sends go back in the queue and are resent, in order, on the next connection.
    this.inFlight.clear();
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
  }

  /** Browsers hide WebSocket pings, so detect dead links with app-level pings. */
  private startLiveness(): void {
    clearInterval(this.livenessTimer);
    this.lastFrameAt = Date.now();
    this.livenessTimer = setInterval(() => {
      if (Date.now() - this.lastFrameAt > this.heartbeatMs * 2 + 5000) {
        this.ws?.close(CloseCode.Normal, "liveness timeout");
        // Some implementations never fire onclose for a dead TCP link.
        const ws = this.ws;
        if (ws) ws.onclose?.({ code: 1006, reason: "liveness timeout" });
        return;
      }
      this.raw({ t: "ping", ts: Date.now() });
    }, this.heartbeatMs);
  }

  // ------------------------------------------------------------------ frames

  private onFrame(f: ServerFrame): void {
    switch (f.t) {
      case "ready":
        return this.onReady(f);
      case "message":
        return this.ingest(f.msg);
      case "sent":
        return this.onSent(f);
      case "sync_result":
        return this.onSyncResult(f);
      case "receipt":
        return this.emit("receipt", f);
      case "typing":
        return this.emit("typing", f);
      case "presence":
        return this.emit("presence", f);
      case "joined":
        this.track(f.conversation);
        this.emit("joined", f.conversation);
        return this.repair(f.conversation.conversationId);
      case "cursors":
        for (const c of f.conversations) {
          this.track(c);
          this.repair(c.conversationId);
        }
        return;
      case "pong":
        return this.emit("rtt", Date.now() - f.ts);
      case "going_away":
        // Move off this node at the server-chosen (jittered) time.
        // (Browsers only let clients send close code 1000 or 3000-4999.)
        setTimeout(() => {
          this.skipBackoff = true;
          this.ws?.close(CloseCode.Normal, "server draining");
        }, f.reconnectInMs);
        return;
      case "error":
        return this.onError(f);
    }
  }

  private onReady(f: Extract<ServerFrame, { t: "ready" }>): void {
    this.userId = f.userId;
    this.heartbeatMs = f.heartbeatMs;
    this.backoff.reset();
    this.setStatus("ready");
    this.startLiveness();
    for (const c of f.conversations) this.track(c);
    this.emit("ready", { userId: f.userId, nodeId: f.nodeId, conversations: f.conversations });
    // Catch up on anything missed while offline, then flush queued sends in order.
    for (const c of f.conversations) if (this.seq.behind(c.conversationId)) this.requestSync(c.conversationId);
    this.pump();
  }

  /** Starts tracking a conversation, choosing where a never-seen one should start. */
  private track(c: ConversationCursor): void {
    if (!this.seq.has(c.conversationId)) {
      const stored = this.storedCursors[c.conversationId];
      this.seq.init(c.conversationId, stored ?? Math.max(0, c.lastSeq - this.opts.backfill));
    }
    this.seq.advertise(c.conversationId, c.lastSeq);
  }

  private ingest(msg: ChatMessage): void {
    if (!this.seq.has(msg.conversationId)) {
      this.track({ conversationId: msg.conversationId, lastSeq: msg.seq, readSeq: 0 });
    }
    if (this.seq.push(msg)) this.scheduleSave();
    this.repair(msg.conversationId);
  }

  /**
   * If we're missing messages, wait briefly (they're often just reordered
   * across nodes and arrive a moment later), then fetch them.
   */
  private repair(conversationId: string): void {
    if (!this.seq.behind(conversationId)) {
      clearTimeout(this.gapTimers.get(conversationId));
      this.gapTimers.delete(conversationId);
      return;
    }
    if (this.gapTimers.has(conversationId) || this.syncing.has(conversationId)) return;
    // A known-but-not-buffered tail (from a cursor) won't arrive live, so fetch now.
    const delay = this.seq.hasHole(conversationId) ? this.opts.gapGraceMs : 0;
    this.gapTimers.set(
      conversationId,
      setTimeout(() => {
        this.gapTimers.delete(conversationId);
        if (this.seq.behind(conversationId)) this.requestSync(conversationId);
      }, delay),
    );
  }

  private requestSync(conversationId: string): void {
    if (this._status !== "ready" || this.syncing.has(conversationId)) return;
    const reqId = `s${++this.reqCounter}`;
    const timer = setTimeout(() => {
      // No answer: forget this attempt and try again.
      if (this.syncing.get(conversationId)?.reqId === reqId) {
        this.syncing.delete(conversationId);
        this.repair(conversationId);
      }
    }, 10_000);
    this.syncing.set(conversationId, { reqId, timer });
    this.raw({ t: "sync", reqId, conversationId, afterSeq: this.seq.cursor(conversationId), limit: 200 });
  }

  private onSyncResult(f: Extract<ServerFrame, { t: "sync_result" }>): void {
    const s = this.syncing.get(f.conversationId);
    if (s?.reqId === f.reqId) {
      clearTimeout(s.timer);
      this.syncing.delete(f.conversationId);
    }
    let delivered = 0;
    for (const m of f.messages) delivered += this.seq.push(m);
    if (delivered) this.scheduleSave();
    if (f.hasMore) this.requestSync(f.conversationId);
    else this.repair(f.conversationId);
  }

  private onSent(f: Extract<ServerFrame, { t: "sent" }>): void {
    const item = this.outbox.get(f.clientMsgId);
    if (item) {
      this.outbox.delete(f.clientMsgId);
      this.inFlight.delete(f.clientMsgId);
      this.scheduleSave();
      this.armAckTimer(true);
      this.pump();
    }
    this.emit("sent", { clientMsgId: f.clientMsgId, conversationId: f.conversationId, seq: f.seq, duplicate: f.duplicate });
    // We already have the content, so the ack doubles as delivery of our own message.
    if (item) {
      this.ingest({
        conversationId: f.conversationId,
        seq: f.seq,
        id: f.id,
        clientMsgId: f.clientMsgId,
        senderId: this.userId,
        body: item.body,
        createdAt: f.createdAt,
      });
    }
  }

  private onError(f: Extract<ServerFrame, { t: "error" }>): void {
    if (f.clientMsgId) {
      const item = this.outbox.get(f.clientMsgId);
      if (!item) return;
      if (f.retryable) {
        // Resending just this one could reorder it behind later sends, so reset
        // the link instead and resend the whole queue in order (with backoff).
        this.ws?.close(CloseCode.Normal, "retry sends");
        return;
      }
      this.outbox.delete(f.clientMsgId);
      this.inFlight.delete(f.clientMsgId);
      this.scheduleSave();
      this.pump();
      this.emit("send_failed", { clientMsgId: f.clientMsgId, conversationId: item.conversationId, code: f.code, message: f.message });
      return;
    }
    if (f.reqId) {
      for (const [conv, s] of this.syncing) {
        if (s.reqId !== f.reqId) continue;
        clearTimeout(s.timer);
        this.syncing.delete(conv);
        if (f.retryable) setTimeout(() => this.repair(conv), 1000);
      }
    }
    this.emit("error", { code: f.code, message: f.message });
  }

  /** Sends queued messages in order, keeping at most `maxInFlight` unacknowledged. */
  private pump(): void {
    if (this._status !== "ready") return;
    for (const item of this.outbox.values()) {
      if (this.inFlight.size >= this.opts.maxInFlight) break;
      if (this.inFlight.has(item.clientMsgId)) continue;
      this.inFlight.add(item.clientMsgId);
      this.raw({ t: "send", conversationId: item.conversationId, clientMsgId: item.clientMsgId, body: item.body });
    }
    this.armAckTimer(false);
  }

  /**
   * TCP doesn't lose frames, so a missing ack means the server or link is
   * stuck. Rather than resend single messages (which could reorder them), reset
   * the connection; reconnecting resends the queue in order and the server dedupes.
   */
  private armAckTimer(progress: boolean): void {
    if (progress || !this.inFlight.size) {
      clearTimeout(this.ackTimer);
      this.ackTimer = undefined;
    }
    if (!this.inFlight.size || this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined;
      if (this.inFlight.size) this.ws?.close(CloseCode.Normal, "ack timeout");
    }, this.opts.ackTimeoutMs);
  }

  private onDeliver(msg: ChatMessage): void {
    this.emit("message", msg);
    if (msg.senderId !== this.userId) {
      this.pendingDelivered.set(msg.conversationId, msg.seq);
      if (!this.deliveredTimer) {
        this.deliveredTimer = setTimeout(() => {
          this.deliveredTimer = undefined;
          for (const [conversationId, seq] of this.pendingDelivered) {
            this.raw({ t: "ack", conversationId, kind: "delivered", seq });
          }
          this.pendingDelivered.clear();
        }, this.opts.deliveredAckMs);
      }
    }
  }

  // ------------------------------------------------------------------ helpers

  private raw(frame: object): void {
    if (this.ws?.readyState === OPEN && this._status === "ready") this.ws.send(JSON.stringify(frame));
  }

  private setStatus(s: Status, detail?: ClientEvents["status"][1]): void {
    this._status = s;
    this.emit("status", s, detail);
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flushSave(), 200);
  }

  private flushSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.storedCursors = { ...this.storedCursors, ...this.seq.snapshot() };
    this.storage.save({ cursors: this.storedCursors, outbox: this.pending() });
  }
}

function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

function randomId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}
