-- Courier schema.
--
-- Key ideas:
--  * Each conversation owns a gapless sequence counter (conversations.last_seq).
--    Assigning a seq is an UPDATE ... RETURNING inside the same transaction as
--    the message insert, so a rolled-back insert never burns a number and clients
--    can treat any jump in seq as a real gap to repair.
--  * (conversation_id, sender_id, client_msg_id) is unique, which makes retries
--    of the same send idempotent.
--  * Messages are hash-partitioned by conversation so one hot table doesn't
--    become one giant index; all reads are by (conversation_id, seq).
--  * The outbox table is written in the same transaction as the message, so a
--    crash between COMMIT and publishing to Redis can't lose the live fan-out.

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username    text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_]{3,32}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text,
  kind        text NOT NULL CHECK (kind IN ('direct', 'group')),
  last_seq    bigint NOT NULL DEFAULT 0,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  -- Per-user cursors (shared by all of the user's devices).
  delivered_seq   bigint NOT NULL DEFAULT 0,
  read_seq        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user_idx ON conversation_members (user_id);

CREATE TABLE messages (
  conversation_id uuid NOT NULL,
  seq             bigint NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  client_msg_id   uuid NOT NULL,
  sender_id       uuid NOT NULL,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq),
  UNIQUE (conversation_id, sender_id, client_msg_id)
) PARTITION BY HASH (conversation_id);

CREATE TABLE messages_p0 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE messages_p1 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE messages_p2 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE messages_p3 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE messages_p4 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE messages_p5 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE messages_p6 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE messages_p7 PARTITION OF messages FOR VALUES WITH (MODULUS 8, REMAINDER 7);

CREATE TABLE outbox (
  id          bigserial PRIMARY KEY,
  channel     text NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_created_idx ON outbox (created_at);
