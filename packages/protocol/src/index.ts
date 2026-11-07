/**
 * Wire protocol shared by the gateway and the client SDK.
 *
 * Every frame is a JSON object with a `t` (type) discriminator. Client frames
 * are validated with zod on the server; server frames are trusted by the client
 * but typed here so both sides stay in lockstep.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  /** Max characters in a message body. */
  maxBodyChars: 4000,
  /** Max raw frame size accepted by the gateway (bytes). */
  maxFrameBytes: 16 * 1024,
  /** Max messages returned by a single sync page. */
  maxSyncPage: 200,
  /** Client must authenticate within this window after connecting. */
  authTimeoutMs: 5000,
} as const;

/** Close codes used by the gateway (4000-4999 is the application range). */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  PolicyViolation: 1008,
  TooBig: 1009,
  TryAgainLater: 1013,
  AuthFailed: 4001,
  AuthTimeout: 4002,
  TokenExpired: 4003,
  SlowConsumer: 4008,
  RateLimited: 4029,
} as const;

const uuid = z.string().uuid();
const convId = uuid;
const seq = z.number().int().nonnegative();

// ---------------------------------------------------------------- client → server

export const AuthFrame = z.object({
  t: z.literal("auth"),
  token: z.string().min(1).max(4096),
  /** Stable per-device id so receipts and presence work across devices. */
  deviceId: z.string().min(1).max(64),
  v: z.literal(PROTOCOL_VERSION),
});

export const SendFrame = z.object({
  t: z.literal("send"),
  conversationId: convId,
  /** Client-generated id; retries with the same id are deduplicated. */
  clientMsgId: uuid,
  body: z.string().min(1).max(LIMITS.maxBodyChars),
});

export const SyncFrame = z.object({
  t: z.literal("sync"),
  /** Echoed back so the client can match the response. */
  reqId: z.string().max(64),
  conversationId: convId,
  afterSeq: seq,
  limit: z.number().int().min(1).max(LIMITS.maxSyncPage).optional(),
});

export const AckFrame = z.object({
  t: z.literal("ack"),
  conversationId: convId,
  kind: z.enum(["delivered", "read"]),
  /** Everything up to and including this seq. */
  seq: seq,
});

export const TypingFrame = z.object({
  t: z.literal("typing"),
  conversationId: convId,
});

export const PingFrame = z.object({ t: z.literal("ping"), ts: z.number() });

export const ClientFrame = z.discriminatedUnion("t", [
  AuthFrame,
  SendFrame,
  SyncFrame,
  AckFrame,
  TypingFrame,
  PingFrame,
]);
export type ClientFrame = z.infer<typeof ClientFrame>;
export type SendFrame = z.infer<typeof SendFrame>;

// ---------------------------------------------------------------- server → client

export interface ChatMessage {
  conversationId: string;
  seq: number;
  id: string;
  clientMsgId: string;
  senderId: string;
  body: string;
  /** ISO timestamp assigned by the server. */
  createdAt: string;
}

export interface ConversationCursor {
  conversationId: string;
  /** Highest seq the server has for this conversation. */
  lastSeq: number;
  /** This user's read cursor, shared across their devices. */
  readSeq: number;
}

export type ServerFrame =
  | {
      t: "ready";
      userId: string;
      sessionId: string;
      nodeId: string;
      conversations: ConversationCursor[];
      heartbeatMs: number;
    }
  | {
      t: "sent";
      clientMsgId: string;
      conversationId: string;
      seq: number;
      id: string;
      createdAt: string;
      /** True when this was a retry of an already-stored message. */
      duplicate: boolean;
    }
  | { t: "message"; msg: ChatMessage }
  | {
      t: "sync_result";
      reqId: string;
      conversationId: string;
      messages: ChatMessage[];
      hasMore: boolean;
    }
  | {
      t: "receipt";
      conversationId: string;
      userId: string;
      kind: "delivered" | "read";
      seq: number;
    }
  | { t: "typing"; conversationId: string; userId: string }
  | { t: "presence"; userId: string; online: boolean }
  | { t: "joined"; conversation: ConversationCursor }
  /** Sent after the server may have missed fan-out (e.g. Redis reconnect); client resyncs any conversation that moved. */
  | { t: "cursors"; conversations: ConversationCursor[] }
  | { t: "pong"; ts: number; serverTs: number }
  | { t: "going_away"; reconnectInMs: number }
  | {
      t: "error";
      code: ErrorCode;
      message: string;
      clientMsgId?: string;
      reqId?: string;
      /** Whether retrying the same request may succeed. */
      retryable: boolean;
    };

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "not_found"
  | "internal";

/** Messages published between gateway nodes over the fan-out bus. */
export type BusEvent =
  | { k: "message"; msg: ChatMessage }
  | { k: "receipt"; conversationId: string; userId: string; kind: "delivered" | "read"; seq: number }
  | { k: "typing"; conversationId: string; userId: string; origin: string }
  | { k: "presence"; conversationId: string; userId: string; online: boolean }
  | { k: "member_added"; conversationId: string; userId: string };

export const channels = {
  conversation: (id: string) => `conv:${id}`,
  user: (id: string) => `user:${id}`,
};

export function parseServerFrame(raw: string): ServerFrame {
  return JSON.parse(raw) as ServerFrame;
}
