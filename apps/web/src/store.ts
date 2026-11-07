import { ChatClient, localStorageStorage, type ChatMessage, type PendingSend, type Status } from "@courier/client";
import { api, refresh, saveSession, type Conversation, type Session } from "./api";

export interface ChatState {
  status: Status;
  nodeId: string;
  rtt: number | null;
  conversations: Conversation[];
  presence: Record<string, boolean>;
  /** conversationId → userId → typing expiry (epoch ms) */
  typing: Record<string, Record<string, number>>;
  failed: { clientMsgId: string; conversationId: string; message: string }[];
  version: number;
}

/**
 * Glue between the SDK and React. The SDK guarantees exactly-once, in-order
 * delivery; this store just keeps view state (conversation list, messages by
 * seq, receipts, presence, typing) and notifies subscribers.
 */
export class ChatStore {
  readonly client: ChatClient;
  private session: Session;
  private messages = new Map<string, Map<number, ChatMessage>>();
  private hasOlder = new Map<string, boolean>();
  private listeners = new Set<() => void>();
  private refreshing?: Promise<Session>;
  activeConversation: string | null = null;
  state: ChatState = {
    status: "idle",
    nodeId: "",
    rtt: null,
    conversations: [],
    presence: {},
    typing: {},
    failed: [],
    version: 0,
  };

  constructor(session: Session, private onLogout: () => void) {
    this.session = session;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.client = new ChatClient({
      url: `${proto}//${location.host}/ws`,
      getToken: () => this.freshToken(),
      storage: localStorageStorage(`courier.client.${session.user.id}`),
      deviceId: deviceId(),
    });

    const c = this.client;
    c.on("status", (status) => this.set({ status }));
    c.on("rtt", (rtt) => this.set({ rtt }));
    c.on("ready", ({ nodeId }) => {
      this.set({ nodeId });
      void this.loadConversations();
    });
    c.on("joined", () => void this.loadConversations());
    c.on("message", (m) => this.onMessage(m));
    c.on("sent", () => this.bump());
    c.on("send_failed", (f) => this.set({ failed: [...this.state.failed, f] }));
    c.on("receipt", (r) => {
      this.updateConversation(r.conversationId, (conv) => ({
        ...conv,
        readSeq: r.userId === this.me && r.kind === "read" ? Math.max(conv.readSeq, r.seq) : conv.readSeq,
        members: conv.members.map((m) =>
          m.id !== r.userId
            ? m
            : {
                ...m,
                deliveredSeq: Math.max(m.deliveredSeq, r.seq),
                readSeq: r.kind === "read" ? Math.max(m.readSeq, r.seq) : m.readSeq,
              },
        ),
      }));
    });
    c.on("typing", ({ conversationId, userId }) => {
      const t = { ...this.state.typing, [conversationId]: { ...this.state.typing[conversationId], [userId]: Date.now() + 4000 } };
      this.set({ typing: t });
      setTimeout(() => this.bump(), 4100);
    });
    c.on("presence", ({ userId, online }) => this.set({ presence: { ...this.state.presence, [userId]: online } }));

    window.addEventListener("online", () => c.reconnectNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        c.reconnectNow();
        if (this.activeConversation) this.markRead(this.activeConversation);
      }
    });
  }

  get me(): string {
    return this.session.user.id;
  }

  get username(): string {
    return this.session.user.username;
  }

  get token(): string {
    return this.session.token;
  }

  // ------------------------------------------------------------ subscriptions

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  private set(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    for (const l of this.listeners) l();
  }

  private bump() {
    this.set({});
  }

  // ------------------------------------------------------------ data

  async loadConversations(): Promise<void> {
    try {
      const fetched = await api.conversations(this.token);
      // Receipts or messages may have arrived while the request was in flight;
      // cursors only move forward, so keep whichever is newer.
      const prev = new Map(this.state.conversations.map((c) => [c.id, c]));
      const conversations = fetched.map((c) => {
        const old = prev.get(c.id);
        if (!old) return c;
        const oldMembers = new Map(old.members.map((m) => [m.id, m]));
        return {
          ...c,
          lastSeq: Math.max(c.lastSeq, old.lastSeq),
          readSeq: Math.max(c.readSeq, old.readSeq),
          lastMessage: (old.lastMessage?.seq ?? 0) > (c.lastMessage?.seq ?? 0) ? old.lastMessage : c.lastMessage,
          members: c.members.map((m) => {
            const o = oldMembers.get(m.id);
            return o ? { ...m, readSeq: Math.max(m.readSeq, o.readSeq), deliveredSeq: Math.max(m.deliveredSeq, o.deliveredSeq) } : m;
          }),
        };
      });
      this.set({ conversations });
      const ids = [...new Set(conversations.flatMap((c) => c.members.map((m) => m.id)))].filter((id) => id !== this.me);
      if (ids.length) this.set({ presence: { ...this.state.presence, ...(await api.presence(this.token, ids)) } });
    } catch (err) {
      console.warn("failed to load conversations", err);
    }
  }

  messagesFor(conversationId: string): ChatMessage[] {
    return [...(this.messages.get(conversationId)?.values() ?? [])].sort((a, b) => a.seq - b.seq);
  }

  pendingFor(conversationId: string): PendingSend[] {
    return this.client.pending(conversationId);
  }

  canLoadOlder(conversationId: string): boolean {
    const msgs = this.messages.get(conversationId);
    if (!msgs?.size) return false;
    return this.hasOlder.get(conversationId) ?? Math.min(...msgs.keys()) > 1;
  }

  async loadOlder(conversationId: string): Promise<void> {
    const msgs = this.messages.get(conversationId);
    const oldest = msgs?.size ? Math.min(...msgs.keys()) : undefined;
    const page = await api.history(this.token, conversationId, oldest);
    for (const m of page) this.store(m);
    this.hasOlder.set(conversationId, page.length === 50 && (page[0]?.seq ?? 1) > 1);
    this.bump();
  }

  /** Opening a conversation with nothing cached pulls the latest page over REST. */
  async open(conversationId: string): Promise<void> {
    this.activeConversation = conversationId;
    if (!this.messages.get(conversationId)?.size) await this.loadOlder(conversationId);
    this.markRead(conversationId);
    this.bump();
  }

  send(conversationId: string, body: string): void {
    this.client.send(conversationId, body);
    this.bump();
  }

  markRead(conversationId: string): void {
    const conv = this.state.conversations.find((c) => c.id === conversationId);
    const last = Math.max(conv?.lastSeq ?? 0, ...(this.messages.get(conversationId)?.keys() ?? [0]));
    if (conv && last > conv.readSeq && document.visibilityState === "visible") {
      this.client.markRead(conversationId, last);
      this.updateConversation(conversationId, (c) => ({ ...c, readSeq: last }));
    }
  }

  dismissFailed(clientMsgId: string): void {
    this.set({ failed: this.state.failed.filter((f) => f.clientMsgId !== clientMsgId) });
  }

  goOffline(): void {
    this.client.close();
  }

  goOnline(): void {
    this.client.connect();
  }

  logout(): void {
    this.client.close();
    saveSession(null);
    this.onLogout();
  }

  // ------------------------------------------------------------ internals

  private store(m: ChatMessage) {
    let map = this.messages.get(m.conversationId);
    if (!map) this.messages.set(m.conversationId, (map = new Map()));
    map.set(m.seq, m);
  }

  private onMessage(m: ChatMessage) {
    this.store(m);
    const known = this.state.conversations.some((c) => c.id === m.conversationId);
    if (!known) void this.loadConversations();
    this.updateConversation(m.conversationId, (c) => ({
      ...c,
      lastSeq: Math.max(c.lastSeq, m.seq),
      updatedAt: m.createdAt,
      lastMessage: m.seq >= c.lastSeq ? { senderId: m.senderId, body: m.body, createdAt: m.createdAt, seq: m.seq } : c.lastMessage,
      readSeq: m.senderId === this.me ? Math.max(c.readSeq, m.seq) : c.readSeq,
    }));
    // Clear the sender's typing indicator once their message lands.
    const typing = this.state.typing[m.conversationId];
    if (typing?.[m.senderId]) {
      const { [m.senderId]: _gone, ...rest } = typing;
      this.set({ typing: { ...this.state.typing, [m.conversationId]: rest } });
    }
    if (this.activeConversation === m.conversationId) this.markRead(m.conversationId);
  }

  private updateConversation(id: string, fn: (c: Conversation) => Conversation) {
    const conversations = this.state.conversations
      .map((c) => (c.id === id ? fn(c) : c))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    this.set({ conversations });
  }

  private async freshToken(): Promise<string> {
    if (this.session.expiresAt - Date.now() > 120_000) return this.session.token;
    this.refreshing ??= refresh(this.session).finally(() => (this.refreshing = undefined));
    try {
      this.session = await this.refreshing;
      saveSession(this.session);
      return this.session.token;
    } catch {
      this.logout();
      throw new Error("session expired");
    }
  }
}

function deviceId(): string {
  let id = localStorage.getItem("courier.device");
  if (!id) localStorage.setItem("courier.device", (id = crypto.randomUUID().slice(0, 18)));
  return id;
}
