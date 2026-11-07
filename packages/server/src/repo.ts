import type { ChatMessage, ConversationCursor } from "@courier/protocol";
import { channels } from "@courier/protocol";
import type { Db } from "./db.js";

interface MessageRow {
  conversation_id: string;
  seq: number;
  id: string;
  client_msg_id: string;
  sender_id: string;
  body: string;
  created_at: Date;
}

const MSG_COLS = "conversation_id, seq, id, client_msg_id, sender_id, body, created_at";

export function toMessage(r: MessageRow): ChatMessage {
  return {
    conversationId: r.conversation_id,
    seq: r.seq,
    id: r.id,
    clientMsgId: r.client_msg_id,
    senderId: r.sender_id,
    body: r.body,
    createdAt: r.created_at.toISOString(),
  };
}

export class ForbiddenError extends Error {
  constructor() {
    super("not a member of this conversation");
  }
}

export type StoreResult = { msg: ChatMessage; duplicate: boolean; outboxId?: number };

export class Repo {
  constructor(private db: Db) {}

  // ------------------------------------------------------------------ users

  async upsertUser(username: string): Promise<{ id: string; username: string }> {
    const { rows } = await this.db.query(
      `INSERT INTO users (username) VALUES ($1)
       ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
       RETURNING id, username`,
      [username],
    );
    return rows[0];
  }

  async findUsersByName(usernames: string[]): Promise<{ id: string; username: string }[]> {
    const { rows } = await this.db.query("SELECT id, username FROM users WHERE username = ANY($1)", [usernames]);
    return rows;
  }

  async searchUsers(prefix: string, limit = 10): Promise<{ id: string; username: string }[]> {
    const { rows } = await this.db.query(
      "SELECT id, username FROM users WHERE username LIKE $1 ORDER BY username LIMIT $2",
      [`${prefix.replace(/[%_\\]/g, "\\$&")}%`, limit],
    );
    return rows;
  }

  // ---------------------------------------------------------- conversations

  async createConversation(creatorId: string, memberIds: string[], title: string | null) {
    const members = [...new Set([creatorId, ...memberIds])];
    const kind = members.length === 2 && !title ? "direct" : "group";
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "INSERT INTO conversations (title, kind, created_by) VALUES ($1, $2, $3) RETURNING id",
        [title, kind, creatorId],
      );
      const id: string = rows[0].id;
      await client.query(
        "INSERT INTO conversation_members (conversation_id, user_id) SELECT $1, unnest($2::uuid[])",
        [id, members],
      );
      await client.query("COMMIT");
      return { id, kind, members };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Adds a member; returns false if they were already in the conversation. */
  async addMember(conversationId: string, actorId: string, userId: string): Promise<boolean> {
    if (!(await this.isMember(conversationId, actorId))) throw new ForbiddenError();
    const { rowCount } = await this.db.query(
      `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [conversationId, userId],
    );
    if (rowCount) {
      await this.db.query("UPDATE conversations SET kind = 'group' WHERE id = $1", [conversationId]);
    }
    return rowCount === 1;
  }

  async isMember(conversationId: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, userId],
    );
    return rowCount === 1;
  }

  async memberIds(conversationId: string): Promise<string[]> {
    const { rows } = await this.db.query(
      "SELECT user_id FROM conversation_members WHERE conversation_id = $1",
      [conversationId],
    );
    return rows.map((r) => r.user_id);
  }

  async conversationIdsFor(userId: string): Promise<string[]> {
    const { rows } = await this.db.query("SELECT conversation_id FROM conversation_members WHERE user_id = $1", [userId]);
    return rows.map((r) => r.conversation_id);
  }

  /** Read cursors for the given conversations. Call after subscribing to fan-out. */
  async cursors(userId: string, conversationIds?: string[]): Promise<ConversationCursor[]> {
    const { rows } = await this.db.query(
      `SELECT c.id, c.last_seq, m.read_seq
         FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.user_id = $1 AND ($2::uuid[] IS NULL OR c.id = ANY($2))`,
      [userId, conversationIds ?? null],
    );
    return rows.map((r) => ({ conversationId: r.id, lastSeq: r.last_seq, readSeq: r.read_seq }));
  }

  /** Conversation list for the UI, newest activity first. */
  async listConversations(userId: string) {
    const { rows } = await this.db.query(
      `SELECT c.id, c.title, c.kind, c.last_seq, c.updated_at, m.read_seq,
              (SELECT json_agg(json_build_object('id', u.id, 'username', u.username,
                                                 'readSeq', cm.read_seq, 'deliveredSeq', cm.delivered_seq) ORDER BY u.username)
                 FROM conversation_members cm JOIN users u ON u.id = cm.user_id
                WHERE cm.conversation_id = c.id) AS members,
              (SELECT json_build_object('senderId', lm.sender_id, 'body', lm.body, 'createdAt', lm.created_at, 'seq', lm.seq)
                 FROM messages lm WHERE lm.conversation_id = c.id AND lm.seq = c.last_seq) AS last_message
         FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.user_id = $1
        ORDER BY c.updated_at DESC
        LIMIT 200`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      lastSeq: r.last_seq,
      readSeq: r.read_seq,
      updatedAt: r.updated_at,
      members: r.members ?? [],
      lastMessage: r.last_message,
    }));
  }

  // --------------------------------------------------------------- messages

  /**
   * Persists a message exactly once and assigns it the next seq.
   *
   * Authorization is enforced inside the same statement that claims the seq,
   * so the database stays the source of truth even if a gateway's view of
   * membership is stale.
   */
  async storeMessage(
    conversationId: string,
    senderId: string,
    clientMsgId: string,
    body: string,
  ): Promise<StoreResult> {
    const existing = await this.findByClientId(conversationId, senderId, clientMsgId);
    if (existing) return { msg: existing, duplicate: true };

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      // Row lock on the conversation serializes writers per conversation and
      // gives a gapless counter (a rollback undoes the increment).
      const seqRes = await client.query(
        `UPDATE conversations SET last_seq = last_seq + 1, updated_at = now()
          WHERE id = $1
            AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2)
        RETURNING last_seq`,
        [conversationId, senderId],
      );
      if (seqRes.rowCount === 0) {
        await client.query("ROLLBACK");
        throw new ForbiddenError();
      }
      const seq: number = seqRes.rows[0].last_seq;
      const ins = await client.query<MessageRow>(
        `INSERT INTO messages (conversation_id, seq, client_msg_id, sender_id, body)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${MSG_COLS}`,
        [conversationId, seq, clientMsgId, senderId, body],
      );
      const msg = toMessage(ins.rows[0]!);
      const ob = await client.query(
        "INSERT INTO outbox (channel, payload) VALUES ($1, $2) RETURNING id",
        [channels.conversation(conversationId), { k: "message", msg }],
      );
      await client.query("COMMIT");
      return { msg, duplicate: false, outboxId: ob.rows[0].id };
    } catch (err: unknown) {
      await client.query("ROLLBACK").catch(() => {});
      // Two retries of the same send raced; the other one won.
      if ((err as { code?: string }).code === "23505") {
        const winner = await this.findByClientId(conversationId, senderId, clientMsgId);
        if (winner) return { msg: winner, duplicate: true };
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async findByClientId(conversationId: string, senderId: string, clientMsgId: string) {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages
        WHERE conversation_id = $1 AND sender_id = $2 AND client_msg_id = $3`,
      [conversationId, senderId, clientMsgId],
    );
    return rows[0] ? toMessage(rows[0]) : null;
  }

  /** Forward page used for gap repair and catch-up. */
  async messagesAfter(conversationId: string, userId: string, afterSeq: number, limit: number) {
    if (!(await this.isMember(conversationId, userId))) throw new ForbiddenError();
    const { rows } = await this.db.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages
        WHERE conversation_id = $1 AND seq > $2
        ORDER BY seq ASC LIMIT $3`,
      [conversationId, afterSeq, limit + 1],
    );
    return { messages: rows.slice(0, limit).map(toMessage), hasMore: rows.length > limit };
  }

  /** Backward page used for scrollback in the UI. */
  async messagesBefore(conversationId: string, userId: string, beforeSeq: number | null, limit: number) {
    if (!(await this.isMember(conversationId, userId))) throw new ForbiddenError();
    const { rows } = await this.db.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages
        WHERE conversation_id = $1 AND ($2::bigint IS NULL OR seq < $2)
        ORDER BY seq DESC LIMIT $3`,
      [conversationId, beforeSeq, limit],
    );
    return rows.reverse().map(toMessage);
  }

  /**
   * Moves a per-user cursor forward (never backward, never past last_seq).
   * Returns the new value, or null if nothing changed.
   */
  async advanceCursor(conversationId: string, userId: string, kind: "delivered" | "read", seq: number) {
    const col = kind === "read" ? "read_seq" : "delivered_seq";
    // Reading implies delivery, so a read also pulls delivered_seq forward.
    const extra = kind === "read" ? ", delivered_seq = GREATEST(m.delivered_seq, LEAST($3, c.last_seq))" : "";
    const { rows } = await this.db.query(
      `UPDATE conversation_members m SET ${col} = LEAST($3, c.last_seq)${extra}
         FROM conversations c
        WHERE m.conversation_id = $1 AND m.user_id = $2 AND c.id = m.conversation_id
          AND m.${col} < LEAST($3, c.last_seq)
      RETURNING m.${col} AS value`,
      [conversationId, userId, seq],
    );
    return rows[0] ? (rows[0].value as number) : null;
  }

  // ----------------------------------------------------------------- outbox

  async deleteOutbox(id: number): Promise<void> {
    await this.db.query("DELETE FROM outbox WHERE id = $1", [id]);
  }

  /**
   * Re-publishes outbox rows whose fast-path publish never happened (e.g. the
   * gateway crashed right after COMMIT). Safe to run on every node at once:
   * SKIP LOCKED hands each row to exactly one sweeper, and clients dedupe by seq
   * if a row is ever published twice.
   */
  async sweepOutbox(
    graceMs: number,
    publish: (channel: string, payload: unknown) => Promise<void>,
    batch = 500,
  ): Promise<number> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT id, channel, payload FROM outbox
          WHERE created_at < now() - make_interval(secs => $1::double precision / 1000)
          ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [graceMs, batch],
      );
      for (const r of rows) await publish(r.channel, r.payload);
      if (rows.length) {
        await client.query("DELETE FROM outbox WHERE id = ANY($1)", [rows.map((r) => r.id)]);
      }
      await client.query("COMMIT");
      return rows.length;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async outboxDepth(): Promise<number> {
    const { rows } = await this.db.query("SELECT count(*)::int AS n FROM outbox");
    return rows[0].n;
  }
}
