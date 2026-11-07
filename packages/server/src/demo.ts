/**
 * Demo bots, so a visitor who arrives alone still has someone to talk to.
 *
 * Bots are ordinary users. Each one connects to this gateway over loopback with
 * the same client SDK the browser uses, so everything a visitor sees from them
 * (typing indicators, read receipts, presence, ordered delivery) goes through
 * the real pipeline. Enable with DEMO_BOTS=true on exactly one gateway.
 */
import { ChatClient, type ChatMessage, type SocketFactory } from "@courier/client";
import type { Logger } from "pino";
import { WebSocket } from "ws";
import type { Gateway } from "./gateway.js";

export const BOT_NAMES = { guide: "guide_bot", maya: "maya_bot", theo: "theo_bot" } as const;
type BotKey = keyof typeof BOT_NAMES;

const MAX_BURST = 100;

const GUIDE_WELCOME = [
  "Hi, I'm the guide. I'm a bot, but a real user on this server: I connect through the same client library your browser uses.",
  "Try this: open Under the hood (top right), turn on “Lose 30% of incoming messages”, then send me /burst 40. All 40 still arrive once, in order. The log shows the gaps being repaired.",
  "You can also drop your connection or go offline and keep typing, then watch your queued messages go out. To chat with a person, use “Open a second user” in the sidebar. Type /help any time.",
];

const GUIDE_HELP =
  "Commands: /burst N sends you N numbered messages at once (up to 100). Anything else, I'll tell you which number your message got in this chat.";

const GUIDE_REPLIES = [
  (seq: number) => `Got it. That was message #${seq} in this chat, and it reached me in order.`,
  (seq: number) => `Received #${seq}. Try /burst 40 with message loss turned on in Under the hood.`,
  (seq: number) => `#${seq} arrived. Your client marked it sent when the server stored it, and the blue ticks mean I've read it.`,
];

const ROOM_GREETING: [BotKey, string][] = [
  ["maya", "Welcome to the demo room! Theo and I are bots, but we type, read and reply like anyone else."],
  ["theo", "Say something and one of us will answer. You can add a second user here with “Add people”."],
];

const ROOM_LINES: Record<"maya" | "theo", string[]> = {
  maya: [
    "Ha, agreed.",
    "Nice. Did my read receipt turn your ticks blue?",
    "Try dropping your connection and sending a message. It waits in the queue and goes out when you're back.",
    "I'm in a lot of these rooms at once, and every one stays in order.",
    "Oh, interesting.",
    "Open a second user from the sidebar and add them here, then it's a real group chat.",
  ],
  theo: [
    "Same here.",
    "Hmm, let me think about that one.",
    "Typing indicators are throttled, so I'm not flooding the server while I type this.",
    "Turn on duplicate messages in Under the hood. You still see each message once.",
    "Good point.",
    "Every message here has a sequence number. Flip on “Show seq” to see them.",
  ],
};

const GREETING = /^(hi|hey|hello|yo|hola|namaste)\b/i;

interface Bot {
  key: BotKey;
  id: string;
  username: string;
  client: ChatClient;
}

export class DemoBots {
  private bots = new Map<BotKey, Bot>();
  private botIds = new Set<string>();
  private lastReply = new Map<string, number>();
  private pending = new Set<NodeJS.Timeout>();
  private lineIndex = new Map<string, number>();
  private log: Logger;

  constructor(private gw: Gateway) {
    this.log = gw.log.child({ module: "demo" });
  }

  isBotName(username: string): boolean {
    return (Object.values(BOT_NAMES) as string[]).includes(username);
  }

  async start(port: number): Promise<void> {
    const url = `ws://127.0.0.1:${port}/ws`;
    for (const key of Object.keys(BOT_NAMES) as BotKey[]) {
      const user = await this.gw.repo.upsertUser(BOT_NAMES[key], true);
      const client = new ChatClient({
        url,
        getToken: () => this.gw.auth.issue(user.id, user.username),
        WebSocket: WebSocket as unknown as SocketFactory,
        deviceId: `bot-${key}`,
        // Bots only react to new messages, never to history after a restart.
        backfill: 0,
        backoff: { baseMs: 200, maxMs: 5000 },
      });
      const bot: Bot = { key, id: user.id, username: user.username, client };
      client.on("message", (m) => this.onMessage(bot, m));
      client.connect();
      this.bots.set(key, bot);
      this.botIds.add(user.id);
    }
    this.log.info("demo bots online");
  }

  stop(): void {
    for (const t of this.pending) clearTimeout(t);
    for (const b of this.bots.values()) b.client.close();
  }

  /**
   * Gives a user a DM with the guide and a group room with two bots, unless
   * they already have them. Returns the conversation ids (DM first).
   */
  async onboard(userId: string): Promise<{ dm: string; room: string }> {
    const guide = this.bot("guide");
    const maya = this.bot("maya");
    const theo = this.bot("theo");
    const shared = await this.gw.repo.sharedConversations(userId, guide.id);
    const existingDm = shared.find((c) => c.kind === "direct");
    const existingRoom = (await this.gw.repo.sharedConversations(userId, maya.id)).find((c) => c.title === "Demo room");
    if (existingDm && existingRoom) return { dm: existingDm.id, room: existingRoom.id };

    const dm = existingDm?.id ?? (await this.gw.repo.createConversation(guide.id, [userId], null)).id;
    const room = existingRoom?.id ?? (await this.gw.repo.createConversation(maya.id, [userId, theo.id], "Demo room")).id;
    if (!existingDm) await this.gw.announceMembers(dm, [userId, guide.id]);
    if (!existingRoom) await this.gw.announceMembers(room, [userId, maya.id, theo.id]);

    // Give the visitor's socket a moment to connect so they see the typing.
    if (!existingDm) this.script(dm, GUIDE_WELCOME.map((text) => ["guide", text] as [BotKey, string]), 1200);
    if (!existingRoom) this.script(room, ROOM_GREETING, 2500);
    return { dm, room };
  }

  // ------------------------------------------------------------------ behaviour

  private onMessage(bot: Bot, m: ChatMessage): void {
    if (this.botIds.has(m.senderId)) return; // never react to bots, including ourselves
    // The guide only lives in DMs and maya/theo only in demo rooms: users
    // can't add bots to their own conversations (see http.ts).
    if (bot.key === "guide") this.guideReply(bot, m);
    else this.roomReply(bot, m);
  }

  private guideReply(bot: Bot, m: ChatMessage): void {
    const text = m.body.trim();
    this.later(() => bot.client.markRead(m.conversationId, m.seq), 300 + Math.random() * 400);

    const burst = text.match(/^\/burst(?:\s+(\d+))?$/i);
    if (burst) {
      const n = Math.max(1, Math.min(MAX_BURST, Number(burst[1] ?? 40)));
      this.later(() => {
        for (let i = 1; i <= n; i++) bot.client.send(m.conversationId, `Burst ${i} of ${n}`);
      }, 400);
      return;
    }
    if (/^\/help$/i.test(text)) return this.type(bot, m.conversationId, GUIDE_HELP, 700);
    if (!this.debounced(`${bot.key}:${m.conversationId}`, 1500)) return;
    const pick = GUIDE_REPLIES[this.nextIndex(`guide:${m.conversationId}`, GUIDE_REPLIES.length)]!;
    this.type(bot, m.conversationId, pick(m.seq), 900 + Math.random() * 700);
  }

  private roomReply(bot: Bot, m: ChatMessage): void {
    if (bot.key !== "maya" && bot.key !== "theo") return;
    this.later(() => bot.client.markRead(m.conversationId, m.seq), 400 + Math.random() * 900);
    // One bot answers each message (alternating); sometimes the other chimes in.
    const mine = bot.key === (m.seq % 2 === 0 ? "maya" : "theo");
    const chimeIn = !mine && Math.random() < 0.3;
    if (!mine && !chimeIn) return;
    if (!this.debounced(`${bot.key}:${m.conversationId}`, 2500)) return;
    const lines = ROOM_LINES[bot.key];
    const text = GREETING.test(m.body.trim())
      ? bot.key === "maya" ? "Hey! 👋" : "Hi there."
      : lines[this.nextIndex(`${bot.key}:${m.conversationId}`, lines.length)]!;
    this.type(bot, m.conversationId, text, (mine ? 1000 : 2600) + Math.random() * 900);
  }

  /** Shows a typing indicator, then sends after `delayMs`. */
  private type(bot: Bot, conversationId: string, text: string, delayMs: number): void {
    this.later(() => bot.client.typing(conversationId), Math.min(300, delayMs / 3));
    this.later(() => bot.client.send(conversationId, text), delayMs);
  }

  private script(conversationId: string, lines: [BotKey, string][], startMs: number): void {
    let at = startMs;
    for (const [key, text] of lines) {
      this.type(this.bot(key), conversationId, text, at);
      at += 1100 + Math.min(1800, text.length * 12);
    }
  }

  private debounced(key: string, ms: number): boolean {
    const now = Date.now();
    if (now - (this.lastReply.get(key) ?? 0) < ms) return false;
    this.lastReply.set(key, now);
    if (this.lastReply.size > 5000) this.lastReply.clear();
    return true;
  }

  private nextIndex(key: string, n: number): number {
    const i = this.lineIndex.get(key) ?? Math.floor(Math.random() * n);
    this.lineIndex.set(key, (i + 1) % n);
    if (this.lineIndex.size > 5000) this.lineIndex.clear();
    return i % n;
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.pending.delete(t);
      fn();
    }, ms);
    this.pending.add(t);
  }

  private bot(key: BotKey): Bot {
    const b = this.bots.get(key);
    if (!b) throw new Error("demo bots not started");
    return b;
  }
}
