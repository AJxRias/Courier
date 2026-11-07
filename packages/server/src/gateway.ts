import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { BusEvent, ClientFrame, ConversationCursor, ErrorCode, ServerFrame } from "@courier/protocol";
import { channels, ClientFrame as ClientFrameSchema, CloseCode, LIMITS } from "@courier/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import pino, { type Logger } from "pino";
import { WebSocketServer, type WebSocket } from "ws";
import { Auth } from "./auth.js";
import { Bus } from "./bus.js";
import type { Config } from "./config.js";
import { Conn } from "./connection.js";
import { createPool, migrate, type Db } from "./db.js";
import { registerHttp } from "./http.js";
import { createMetrics, type Metrics } from "./metrics.js";
import { Presence } from "./presence.js";
import { Throttle } from "./ratelimit.js";
import { ForbiddenError, Repo } from "./repo.js";

/** Fault injection for tests and chaos drills. All off by default. */
export interface Faults {
  /** Skip the post-commit publish, leaving delivery to the outbox sweeper. */
  skipFastPathPublish?: boolean;
  /** Drop matching incoming bus events, simulating lost pub/sub messages. */
  dropBusEvent?: (event: BusEvent) => boolean;
}

/** Max sends one socket may have queued; the SDK pipelines far fewer. */
const MAX_QUEUED_SENDS = 128;
/** A send that would wait longer than this for a rate-limit token closes the socket instead. */
const MAX_SEND_DELAY_MS = 10_000;

export interface GatewayOptions {
  config: Config;
  logger?: Logger;
  runMigrations?: boolean;
  faults?: Faults;
}

export class Gateway {
  readonly config: Config;
  readonly log: Logger;
  readonly db: Db;
  readonly repo: Repo;
  readonly auth: Auth;
  readonly bus: Bus;
  readonly presence: Presence;
  readonly metrics: Metrics;
  readonly http: FastifyInstance;
  readonly faults: Faults;

  private wss: WebSocketServer;
  private conns = new Set<Conn>();
  private byConversation = new Map<string, Set<Conn>>();
  private byUser = new Map<string, Set<Conn>>();
  private typingThrottle = new Throttle(2000);
  private intervals: NodeJS.Timeout[] = [];
  private sweeping = false;
  private draining = false;
  private crashed = false;
  private runMigrations: boolean;

  constructor(opts: GatewayOptions) {
    this.config = opts.config;
    this.faults = opts.faults ?? {};
    this.runMigrations = opts.runMigrations ?? true;
    this.log = (opts.logger ?? pino({ level: this.config.logLevel })).child({ node: this.config.nodeId });
    this.db = createPool(this.config.databaseUrl);
    this.repo = new Repo(this.db);
    this.auth = new Auth(this.config.jwtSecret, this.config.tokenTtlSec);
    this.metrics = createMetrics(this.config.nodeId);
    this.bus = new Bus(
      this.config.redisUrl,
      this.log,
      (ch, ev) => this.onBusEvent(ch, ev),
      () => void this.refreshAllCursors(),
    );
    this.presence = new Presence(this.bus.pub, this.config.nodeId, this.config.heartbeatMs * 3);
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: LIMITS.maxFrameBytes,
      perMessageDeflate: false, // CPU-expensive per socket; chat frames are small anyway
    });
    this.http = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: true });
    registerHttp(this);
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<{ port: number }> {
    if (this.runMigrations) {
      const applied = await migrate(this.db);
      if (applied.length) this.log.info({ applied }, "migrations applied");
    }
    await this.bus.ready();
    this.http.server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
    await this.http.listen({ host: this.config.host, port: this.config.port });
    const addr = this.http.server.address();
    const port = typeof addr === "object" && addr ? addr.port : this.config.port;

    this.intervals.push(setInterval(() => this.heartbeat(), this.config.heartbeatMs));
    this.intervals.push(setInterval(() => void this.sweepOutbox(), this.config.outboxSweepMs));
    this.log.info({ port }, "gateway listening");
    return { port };
  }

  get isDraining(): boolean {
    return this.draining;
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  /**
   * Graceful shutdown: refuse new sockets, ask clients to reconnect elsewhere
   * spread over the drain window (so a deploy doesn't cause a thundering herd),
   * then stop.
   */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.log.info({ conns: this.conns.size }, "draining");
    const window = this.config.drainWindowMs;
    for (const c of this.conns) {
      const delay = Math.floor(Math.random() * window);
      // The client moves itself after `delay`; the close is a backstop.
      c.send({ t: "going_away", reconnectInMs: delay });
      const t = setTimeout(() => c.close(CloseCode.GoingAway, "server draining"), delay + 2000);
      t.unref();
    }
    const deadline = Date.now() + window + 5000;
    while (this.conns.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    for (const c of this.conns) c.ws.terminate();
    await this.sweepOutbox();
    await this.stop();
  }

  async stop(): Promise<void> {
    for (const i of this.intervals) clearInterval(i);
    this.intervals = [];
    for (const c of this.conns) c.ws.terminate();
    this.wss.close();
    await this.http.close().catch(() => {});
    await this.bus.close();
    await this.db.end().catch(() => {});
  }

  /**
   * Simulates the process dying: sockets drop with no close frame, nothing is
   * cleaned up, presence entries are left to expire. Used by chaos tests.
   */
  async crash(): Promise<void> {
    this.crashed = true;
    for (const i of this.intervals) clearInterval(i);
    this.intervals = [];
    for (const c of this.conns) c.ws.terminate();
    this.wss.close();
    this.http.server.closeAllConnections?.();
    await this.http.close().catch(() => {});
    this.bus.kill();
    await this.db.end().catch(() => {});
  }

  // ------------------------------------------------------------ connections

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://x");
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== "/ws") return reject(404, "Not Found");
    if (this.draining || this.crashed) return reject(503, "Service Unavailable");
    // Browsers always send Origin; refusing unknown origins blocks cross-site
    // WebSocket hijacking. Non-browser clients still need a valid JWT.
    const origin = req.headers.origin;
    if (origin && this.config.allowedOrigins.length && !this.config.allowedOrigins.includes(origin)) {
      this.metrics.disconnects.inc({ reason: "bad_origin" });
      return reject(403, "Forbidden");
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const remote = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "";
    const conn = new Conn(
      randomUUID(),
      ws,
      remote,
      this.config,
      () => this.metrics.disconnects.inc({ reason: "slow_consumer" }),
      (type) => this.metrics.framesOut.inc({ type }),
    );
    this.conns.add(conn);

    conn.timers.push(
      setTimeout(() => {
        if (!conn.principal) {
          this.metrics.disconnects.inc({ reason: "auth_timeout" });
          conn.close(CloseCode.AuthTimeout, "auth timeout");
        }
      }, LIMITS.authTimeoutMs),
    );

    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (data, isBinary) => this.onFrame(conn, data as Buffer, isBinary));
    ws.on("close", () => void this.onClose(conn));
    ws.on("error", (err) => this.log.debug({ err: err.message, conn: conn.id }, "socket error"));
  }

  private onFrame(conn: Conn, data: Buffer, isBinary: boolean): void {
    if (!conn.frameBucket.take()) {
      this.metrics.rateLimited.inc({ kind: "frame" });
      this.metrics.disconnects.inc({ reason: "flood" });
      return conn.close(CloseCode.RateLimited, "too many frames");
    }
    if (isBinary) return this.sendError(conn, "bad_request", "binary frames not supported", false);

    let frame: ClientFrame;
    try {
      const parsed = ClientFrameSchema.safeParse(JSON.parse(data.toString("utf8")));
      if (!parsed.success) {
        return this.sendError(conn, "bad_request", parsed.error.issues[0]?.message ?? "invalid frame", false);
      }
      frame = parsed.data;
    } catch {
      return this.sendError(conn, "bad_request", "invalid JSON", false);
    }

    if (frame.t === "auth") return void this.handleAuth(conn, frame);
    if (!conn.principal) {
      this.metrics.disconnects.inc({ reason: "unauthenticated" });
      return conn.close(CloseCode.AuthFailed, "authenticate first");
    }

    switch (frame.t) {
      case "send":
        // Bounded queue: a well-behaved client pipelines a small window of sends.
        if (conn.queued >= MAX_QUEUED_SENDS) {
          this.metrics.rateLimited.inc({ kind: "send_queue" });
          this.metrics.disconnects.inc({ reason: "send_queue_full" });
          return conn.close(CloseCode.RateLimited, "too many pending sends");
        }
        return conn.serial(() => this.handleSend(conn, frame));
      case "sync":
        return void this.handleSync(conn, frame);
      case "ack":
        return void this.handleAck(conn, frame);
      case "typing":
        return void this.handleTyping(conn, frame);
      case "ping":
        return conn.send({ t: "pong", ts: frame.ts, serverTs: Date.now() });
    }
  }

  private async handleAuth(conn: Conn, frame: Extract<ClientFrame, { t: "auth" }>): Promise<void> {
    if (conn.principal) return this.sendError(conn, "bad_request", "already authenticated", false);
    try {
      conn.principal = await this.auth.verify(frame.token);
    } catch {
      this.metrics.disconnects.inc({ reason: "auth_failed" });
      return conn.close(CloseCode.AuthFailed, "invalid token");
    }
    conn.deviceId = frame.deviceId;
    const userId = conn.userId;

    // The socket lives no longer than its token; the client reconnects with a fresh one.
    const msLeft = conn.principal.exp * 1000 - Date.now();
    conn.timers.push(setTimeout(() => conn.close(CloseCode.TokenExpired, "token expired"), Math.max(0, msLeft)));

    index(this.byUser, userId, conn);
    try {
      const convIds = await this.repo.conversationIdsFor(userId);
      // Order matters: subscribe to fan-out *before* reading cursors. Anything
      // committed after the cursor read arrives live; anything before it is
      // covered by lastSeq and fetched with sync. Nothing falls in between.
      await Promise.all([
        this.acquire(conn, channels.user(userId)),
        ...convIds.map((id) => this.joinConversation(conn, id)),
      ]);
      const cursors = await this.repo.cursors(userId);
      if (conn.closed) return;

      this.metrics.connections.inc();
      conn.send({
        t: "ready",
        userId,
        sessionId: conn.id,
        nodeId: this.config.nodeId,
        conversations: cursors,
        heartbeatMs: this.config.heartbeatMs,
      });

      if (await this.presence.connect(userId, conn.id)) {
        await this.publishPresence(userId, convIds, true);
      }
    } catch (err) {
      this.log.error({ err, userId }, "auth setup failed");
      conn.close(CloseCode.TryAgainLater, "server error");
    }
  }

  private async onClose(conn: Conn): Promise<void> {
    if (conn.closed) return;
    conn.closed = true;
    conn.clearTimers();
    this.conns.delete(conn);
    if (!conn.principal) return;
    this.metrics.connections.dec();
    unindex(this.byUser, conn.userId, conn);
    for (const id of conn.conversations) unindex(this.byConversation, id, conn);
    for (const ch of conn.channels) this.bus.release(ch);
    if (this.crashed) return;
    try {
      if (await this.presence.disconnect(conn.userId, conn.id)) {
        await this.publishPresence(conn.userId, [...conn.conversations], false);
      }
    } catch (err) {
      this.log.warn({ err }, "presence cleanup failed");
    }
  }

  private async acquire(conn: Conn, channel: string): Promise<void> {
    if (conn.channels.has(channel)) return;
    conn.channels.add(channel);
    await this.bus.acquire(channel);
    // If the socket closed while we were subscribing, onClose already released
    // everything it knew about; give this one back too.
    if (conn.closed) this.bus.release(channel);
  }

  private async joinConversation(conn: Conn, conversationId: string): Promise<void> {
    if (conn.conversations.has(conversationId)) return;
    conn.conversations.add(conversationId);
    index(this.byConversation, conversationId, conn);
    await this.acquire(conn, channels.conversation(conversationId));
  }

  // ------------------------------------------------------------ frame handlers

  private async handleSend(conn: Conn, f: Extract<ClientFrame, { t: "send" }>): Promise<void> {
    if (conn.closed || conn.failed) return;
    // Backpressure, not rejection: over the rate, the send waits its turn.
    // Rejecting would force client retries that can land out of order.
    const wait = conn.sendBucket.reserve(MAX_SEND_DELAY_MS);
    if (wait < 0) {
      this.metrics.disconnects.inc({ reason: "send_rate" });
      return conn.close(CloseCode.RateLimited, "send rate exceeded");
    }
    if (wait > 0) {
      this.metrics.rateLimited.inc({ kind: "send_delayed" });
      await new Promise((r) => setTimeout(r, wait));
      if (conn.closed || conn.failed) return;
    }
    const end = this.metrics.sendDuration.startTimer();
    try {
      const body = f.body.normalize("NFC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
      if (!body.trim()) {
        return this.sendError(conn, "bad_request", "empty message", false, { clientMsgId: f.clientMsgId });
      }
      const res = await this.repo.storeMessage(f.conversationId, conn.userId, f.clientMsgId, body);
      conn.send({
        t: "sent",
        clientMsgId: f.clientMsgId,
        conversationId: f.conversationId,
        seq: res.msg.seq,
        id: res.msg.id,
        createdAt: res.msg.createdAt,
        duplicate: res.duplicate,
      });
      end();
      this.metrics.messages.inc({ result: res.duplicate ? "duplicate" : "stored" });

      if (res.outboxId !== undefined && !this.faults.skipFastPathPublish) {
        // Fast path. If this fails or we crash right here, the sweeper
        // publishes the outbox row instead.
        const outboxId = res.outboxId;
        this.bus
          .publish(channels.conversation(f.conversationId), { k: "message", msg: res.msg } satisfies BusEvent)
          .then(() => this.repo.deleteOutbox(outboxId))
          .catch((err) => this.log.warn({ err: err.message }, "fast-path publish failed; sweeper will retry"));
      }
    } catch (err) {
      if (err instanceof ForbiddenError) {
        this.metrics.messages.inc({ result: "forbidden" });
        return this.sendError(conn, "forbidden", err.message, false, { clientMsgId: f.clientMsgId });
      }
      this.metrics.messages.inc({ result: "error" });
      this.log.error({ err }, "send failed");
      // Fail-stop: drop the connection so no later send on it can be stored
      // ahead of this one. The client reconnects and resends its outbox in order.
      conn.failed = true;
      conn.close(CloseCode.TryAgainLater, "could not store message");
    }
  }

  private async handleSync(conn: Conn, f: Extract<ClientFrame, { t: "sync" }>): Promise<void> {
    this.metrics.syncs.inc();
    try {
      const page = await this.repo.messagesAfter(f.conversationId, conn.userId, f.afterSeq, f.limit ?? 100);
      conn.send({ t: "sync_result", reqId: f.reqId, conversationId: f.conversationId, ...page });
    } catch (err) {
      if (err instanceof ForbiddenError) return this.sendError(conn, "forbidden", err.message, false, { reqId: f.reqId });
      this.log.error({ err }, "sync failed");
      this.sendError(conn, "internal", "sync failed", true, { reqId: f.reqId });
    }
  }

  private async handleAck(conn: Conn, f: Extract<ClientFrame, { t: "ack" }>): Promise<void> {
    try {
      const seq = await this.repo.advanceCursor(f.conversationId, conn.userId, f.kind, f.seq);
      if (seq === null) return;
      const ev: BusEvent = { k: "receipt", conversationId: f.conversationId, userId: conn.userId, kind: f.kind, seq };
      await this.bus.publish(channels.conversation(f.conversationId), ev);
    } catch (err) {
      this.log.warn({ err }, "ack failed");
    }
  }

  private async handleTyping(conn: Conn, f: Extract<ClientFrame, { t: "typing" }>): Promise<void> {
    if (!conn.conversations.has(f.conversationId)) return;
    if (!this.typingThrottle.allow(`${conn.userId}:${f.conversationId}`)) return;
    const ev: BusEvent = { k: "typing", conversationId: f.conversationId, userId: conn.userId, origin: this.config.nodeId };
    await this.bus.publish(channels.conversation(f.conversationId), ev).catch(() => {});
  }

  private sendError(
    conn: Conn,
    code: ErrorCode,
    message: string,
    retryable: boolean,
    extra: { clientMsgId?: string; reqId?: string } = {},
  ): void {
    conn.send({ t: "error", code, message, retryable, ...extra });
  }

  // ------------------------------------------------------------ fan-out

  private onBusEvent(channel: string, ev: BusEvent): void {
    if (this.faults.dropBusEvent?.(ev)) return;

    if (channel.startsWith("user:")) {
      if (ev.k === "member_added") void this.onMemberAdded(ev.userId, ev.conversationId);
      return;
    }
    const conns = this.byConversation.get(ev.k === "message" ? ev.msg.conversationId : ev.conversationId);
    if (!conns?.size) return;

    switch (ev.k) {
      case "message": {
        const frame = JSON.stringify({ t: "message", msg: ev.msg } satisfies ServerFrame);
        for (const c of conns) c.send(frame, "message");
        this.metrics.fanoutLag.observe(Math.max(0, Date.now() - Date.parse(ev.msg.createdAt)) / 1000);
        return;
      }
      case "receipt": {
        const frame = JSON.stringify({ t: "receipt", conversationId: ev.conversationId, userId: ev.userId, kind: ev.kind, seq: ev.seq } satisfies ServerFrame);
        for (const c of conns) c.send(frame, "receipt");
        return;
      }
      case "typing": {
        const frame = JSON.stringify({ t: "typing", conversationId: ev.conversationId, userId: ev.userId } satisfies ServerFrame);
        for (const c of conns) if (c.principal?.userId !== ev.userId) c.send(frame, "typing");
        return;
      }
      case "presence": {
        // Published once per conversation the user is in, so dedupe per socket.
        const frame = JSON.stringify({ t: "presence", userId: ev.userId, online: ev.online } satisfies ServerFrame);
        for (const c of conns) {
          if (c.principal?.userId === ev.userId || c.presenceSeen.get(ev.userId) === ev.online) continue;
          c.presenceSeen.set(ev.userId, ev.online);
          c.send(frame, "presence");
        }
        return;
      }
    }
  }

  private async onMemberAdded(userId: string, conversationId: string): Promise<void> {
    const conns = this.byUser.get(userId);
    if (!conns?.size) return;
    await Promise.all([...conns].map((c) => this.joinConversation(c, conversationId)));
    const [cursor] = await this.repo.cursors(userId, [conversationId]);
    if (!cursor) return;
    for (const c of conns) c.send({ t: "joined", conversation: cursor });
  }

  /** Publishes membership changes so every node holding the user's sockets subscribes them. */
  async announceMembers(conversationId: string, userIds: string[]): Promise<void> {
    await Promise.all(
      userIds.map((userId) =>
        this.bus.publish(channels.user(userId), { k: "member_added", conversationId, userId } satisfies BusEvent),
      ),
    );
  }

  private async publishPresence(userId: string, convIds: string[], online: boolean): Promise<void> {
    await Promise.all(
      convIds.map((conversationId) =>
        this.bus.publish(channels.conversation(conversationId), { k: "presence", conversationId, userId, online } satisfies BusEvent),
      ),
    );
  }

  /** After a bus outage, nudge every client to compare cursors and resync. */
  private async refreshAllCursors(): Promise<void> {
    this.metrics.busReconnects.inc();
    const users = [...this.byUser.keys()];
    for (const userId of users) {
      const cursors: ConversationCursor[] = await this.repo.cursors(userId).catch(() => []);
      for (const c of this.byUser.get(userId) ?? []) c.send({ t: "cursors", conversations: cursors });
    }
  }

  // ------------------------------------------------------------ background

  private heartbeat(): void {
    const live: { userId: string; sessionId: string }[] = [];
    for (const c of this.conns) {
      if (!c.alive) {
        this.metrics.disconnects.inc({ reason: "heartbeat" });
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
      if (c.principal) live.push({ userId: c.userId, sessionId: c.id });
    }
    this.presence.refresh(live).catch((err) => this.log.warn({ err: err.message }, "presence refresh failed"));
  }

  async sweepOutbox(): Promise<number> {
    if (this.sweeping || this.crashed) return 0;
    this.sweeping = true;
    try {
      const n = await this.repo.sweepOutbox(this.config.outboxGraceMs, (ch, payload) => this.bus.publish(ch, payload));
      if (n) {
        this.metrics.outboxSwept.inc(n);
        this.log.info({ n }, "outbox sweeper re-published rows");
      }
      return n;
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "outbox sweep failed");
      return 0;
    } finally {
      this.sweeping = false;
    }
  }
}

function index<K>(map: Map<K, Set<Conn>>, key: K, conn: Conn): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(conn);
}

function unindex<K>(map: Map<K, Set<Conn>>, key: K, conn: Conn): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(conn);
  if (!set.size) map.delete(key);
}
