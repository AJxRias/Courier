import type { ServerFrame } from "@courier/protocol";
import { CloseCode } from "@courier/protocol";
import type { WebSocket } from "ws";
import type { Principal } from "./auth.js";
import { TokenBucket } from "./ratelimit.js";

export interface ConnLimits {
  maxBufferedBytes: number;
  sendRatePerSec: number;
  sendBurst: number;
  frameRatePerSec: number;
  frameBurst: number;
}

/** Per-socket state. One user may have many of these (devices, tabs). */
export class Conn {
  principal: Principal | null = null;
  deviceId = "";
  alive = true;
  closed = false;
  /** A send failed; ignore the rest of the queue (fail-stop keeps per-sender order). */
  failed = false;
  /** Conversations this socket receives fan-out for. */
  readonly conversations = new Set<string>();
  /** Bus channels this socket holds a reference on (released on close). */
  readonly channels = new Set<string>();
  readonly sendBucket: TokenBucket;
  readonly frameBucket: TokenBucket;
  timers: NodeJS.Timeout[] = [];
  /** Sends from one socket are processed in order, so a user's messages keep their order. */
  private queue: Promise<void> = Promise.resolve();
  /** Last presence state sent per user; presence arrives once per shared conversation. */
  readonly presenceSeen = new Map<string, boolean>();
  /** Sends received but not yet processed. */
  queued = 0;

  constructor(
    readonly id: string,
    readonly ws: WebSocket,
    readonly remote: string,
    private limits: ConnLimits,
    private onSlow: (c: Conn) => void,
    private onFrameOut: (type: string) => void,
  ) {
    this.sendBucket = new TokenBucket(limits.sendRatePerSec, limits.sendBurst);
    this.frameBucket = new TokenBucket(limits.frameRatePerSec, limits.frameBurst);
  }

  get userId(): string {
    return this.principal!.userId;
  }

  /**
   * Writes a frame, or a pre-serialized frame string (so fan-out serializes
   * once per message, not once per recipient). Disconnects clients that can't
   * keep up instead of buffering without bound.
   */
  send(frame: ServerFrame | string, type?: string): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > this.limits.maxBufferedBytes) {
      this.onSlow(this);
      this.close(CloseCode.SlowConsumer, "slow consumer");
      return;
    }
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    this.onFrameOut(type ?? (typeof frame === "string" ? "raw" : frame.t));
  }

  serial(task: () => Promise<void>): void {
    this.queued++;
    const run = () => task().finally(() => this.queued--);
    this.queue = this.queue.then(run, run);
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
      this.ws.close(code, reason);
      // Don't wait forever on a peer that never completes the close handshake.
      const t = setTimeout(() => this.ws.terminate(), 5000);
      t.unref();
    }
  }

  clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
