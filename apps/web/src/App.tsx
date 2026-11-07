import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import {
  api,
  chatWithParam,
  devLogin,
  displayName,
  guestName,
  isGuestTab,
  loadSession,
  saveSession,
  type Conversation,
  type Member,
  type Session,
} from "./api";
import { ChatStore, type ChatState, type LogLine } from "./store";

const REPO_URL = "https://github.com/AJxRias/Courier";

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [guestError, setGuestError] = useState("");
  const store = useMemo(() => (session ? new ChatStore(session, () => setSession(null)) : null), [session]);

  useEffect(() => {
    store?.client.connect();
    return () => store?.client.close();
  }, [store]);

  // A "second user" tab signs itself in as a fresh guest.
  useEffect(() => {
    if (!isGuestTab || session) return;
    devLogin(guestName())
      .then((s) => (saveSession(s), setSession(s)))
      .catch((err) => setGuestError((err as Error).message));
  }, [session]);

  if (!session || !store) {
    if (isGuestTab) return <div className="boot">{guestError ? `Couldn't create a second user: ${guestError}` : "Setting up a second user…"}</div>;
    return <Login onLogin={(s) => (saveSession(s), setSession(s))} />;
  }
  return <Shell store={store} />;
}

// ---------------------------------------------------------------- shared bits

function Mark({ size = 18 }: { size?: number }) {
  return <span className="mark" style={{ width: size, height: size }} aria-hidden />;
}

const HUES = [214, 262, 336, 18, 152, 192, 40, 290];
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length]!;
}

function Avatar({ name, bot, online, size = 36 }: { name: string; bot?: boolean; online?: boolean; size?: number }) {
  return (
    <span className={`avatar ${bot ? "bot" : ""}`} style={{ width: size, height: size, ["--h" as string]: hue(name) }}>
      {name.slice(0, 1).toUpperCase()}
      {online && <span className="online-dot" />}
    </span>
  );
}

function BotTag() {
  return <span className="bot-tag">bot</span>;
}

function Switch({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden />
      <span>{children}</span>
    </label>
  );
}

// ---------------------------------------------------------------- login

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const go = async (username: string) => {
    setBusy(true);
    setError("");
    try {
      onLogin(await devLogin(username));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-intro">
        <div className="brand-lg">
          <Mark size={30} />
          Courier
        </div>
        <h1>Chat that delivers every message once, in order, even when servers crash or the network drops.</h1>
      </div>
      <ul className="login-points">
          <li>A guide bot and a demo room are waiting for you, so you can start chatting straight away.</li>
          <li>Open <b>Under the hood</b> to watch each message travel, then break the network on purpose and see it recover.</li>
          <li>
            Built with TypeScript, WebSockets, PostgreSQL and Redis. Load-tested with 5,000 clients and a server killed mid-test:
            nothing lost. <a href={REPO_URL} target="_blank" rel="noreferrer">Source and results on GitHub</a>.
          </li>
      </ul>
      <div className="login-card">
        <button className="btn primary big" disabled={busy} onClick={() => go(guestName())}>
          {busy ? "Signing in…" : "Try it now"}
        </button>
        <p className="muted small center">No sign-up. You get a random guest name.</p>
        <div className="or">or pick a username</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void go(name.trim().toLowerCase());
          }}
        >
          <input placeholder="e.g. arjuna" value={name} onChange={(e) => setName(e.target.value)} pattern="[a-zA-Z0-9_]{3,32}" required aria-label="Username" />
          <button className="btn" disabled={busy}>Continue</button>
        </form>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- shell

function title(c: Conversation, me: string): string {
  return c.title ?? (c.members.filter((m) => m.id !== me).map((m) => displayName(m)).join(", ") || "Just you");
}

function other(c: Conversation, me: string): Member | undefined {
  return c.kind === "direct" ? c.members.find((m) => m.id !== me) : undefined;
}

function Shell({ store }: { store: ChatStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [active, setActive] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showSeq, setShowSeq] = useState(false);
  const [inspector, setInspector] = useState(() => window.innerWidth >= 1200);
  const [demoBusy, setDemoBusy] = useState(false);
  const pendingWith = useRef(chatWithParam);
  const conv = state.conversations.find((c) => c.id === active) ?? null;

  useEffect(() => {
    if (active) void store.open(active);
  }, [active, store]);

  // Second-user tab: start a chat with whoever opened it.
  useEffect(() => {
    const target = pendingWith.current;
    if (!target || state.status !== "ready") return;
    pendingWith.current = null;
    history.replaceState(null, "", "/?guest=1");
    api
      .createConversation(store.token, [target])
      .then(async ({ id }) => {
        await store.loadConversations();
        setActive(id);
      })
      .catch(() => {});
  }, [state.status, store]);

  // On wide screens, open something rather than showing an empty pane.
  useEffect(() => {
    if (active || pendingWith.current || !state.conversations.length || window.innerWidth < 760) return;
    const guide = state.conversations.find((c) => other(c, store.me)?.username === "guide_bot");
    setActive((guide ?? state.conversations[0]!).id);
  }, [active, state.conversations, store.me]);

  const startDemo = async () => {
    setDemoBusy(true);
    try {
      setActive(await store.startDemo());
    } finally {
      setDemoBusy(false);
    }
  };

  return (
    <div className={`app ${active ? "has-active" : ""} ${inspector ? "with-inspector" : ""}`}>
      <aside className="sidebar">
        <header className="sidebar-head">
          <div className="brand">
            <Mark />
            Courier
          </div>
          <button className="btn small" onClick={() => setShowNew(true)}>New chat</button>
        </header>
        <ul className="conv-list">
          {state.conversations.map((c) => (
            <ConversationRow key={c.id} c={c} me={store.me} active={c.id === active} presence={state.presence} onClick={() => setActive(c.id)} />
          ))}
        </ul>
        {!state.conversations.some((c) => other(c, store.me)?.isBot) && (
          <div className="sidebar-note">
            <p>Nobody to talk to yet? Bring in the demo bots.</p>
            <button className="btn small" disabled={demoBusy} onClick={startDemo}>Add demo chats</button>
          </div>
        )}
        <footer className="sidebar-foot">
          <button className="btn ghost wide" onClick={() => store.openSecondUser()}>
            Open a second user
            <span className="muted small">New tab, already chatting with you</span>
          </button>
          <div className="me-row">
            <Avatar name={store.username} size={28} />
            <span className="me">{store.username}</span>
            <ConnectionDot status={state.status} />
            <button className="btn ghost small" onClick={() => store.logout()}>Log out</button>
          </div>
        </footer>
      </aside>

      <main className="main">
        {conv ? (
          <ConversationView
            key={conv.id}
            store={store}
            state={state}
            conv={conv}
            showSeq={showSeq}
            inspectorOpen={inspector}
            onToggleInspector={() => setInspector((v) => !v)}
            onBack={() => setActive(null)}
          />
        ) : (
          <div className="empty">
            {state.conversations.length ? (
              <p className="muted">Pick a conversation.</p>
            ) : (
              <div className="empty-card">
                <h2>Your demo chats are on the way</h2>
                <p className="muted">If nothing shows up in a few seconds, add them yourself.</p>
                <button className="btn primary" disabled={demoBusy} onClick={startDemo}>Add demo chats</button>
              </div>
            )}
          </div>
        )}
      </main>

      {inspector && (
        <Inspector store={store} state={state} showSeq={showSeq} onShowSeq={setShowSeq} onClose={() => setInspector(false)} />
      )}
      {showNew && <NewConversation store={store} onClose={() => setShowNew(false)} onCreated={(id) => (setShowNew(false), setActive(id))} />}
    </div>
  );
}

function ConnectionDot({ status }: { status: string }) {
  const label = status === "ready" ? "Connected" : status === "closed" ? "Offline" : "Reconnecting";
  return (
    <span className={`conn conn-${status === "ready" ? "ok" : status === "closed" ? "off" : "wait"}`} title={label}>
      <span className="conn-dot" />
      {label}
    </span>
  );
}

function ConversationRow(props: { c: Conversation; me: string; active: boolean; presence: Record<string, boolean>; onClick: () => void }) {
  const { c, me } = props;
  const unread = Math.max(0, c.lastSeq - c.readSeq);
  const peer = other(c, me);
  const name = title(c, me);
  const lm = c.lastMessage;
  const who = lm ? (lm.senderId === me ? "You: " : c.kind === "group" ? `${displayName(c.members.find((m) => m.id === lm.senderId))}: ` : "") : "";
  return (
    <li>
      <button className={`conv-row ${props.active ? "active" : ""}`} onClick={props.onClick}>
        <Avatar name={name} bot={peer?.isBot} online={!!peer && props.presence[peer.id]} />
        <span className="conv-text">
          <span className="conv-title">
            {name}
            {peer?.isBot && <BotTag />}
          </span>
          <span className="conv-preview">{lm ? who + lm.body : "No messages yet"}</span>
        </span>
        {unread > 0 && !props.active && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------- conversation

function ConversationView(props: {
  store: ChatStore;
  state: ChatState;
  conv: Conversation;
  showSeq: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onBack: () => void;
}) {
  const { store, state, conv, showSeq } = props;
  const messages = store.messagesFor(conv.id);
  const pending = store.pendingFor(conv.id);
  const failed = state.failed.filter((f) => f.conversationId === conv.id);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const others = conv.members.filter((m) => m.id !== store.me);
  const peer = other(conv, store.me);
  const readUpTo = Math.max(0, ...others.map((m) => m.readSeq));
  const deliveredUpTo = Math.max(0, ...others.map((m) => m.deliveredSeq));
  const typers = Object.entries(state.typing[conv.id] ?? {})
    .filter(([, exp]) => exp > Date.now())
    .map(([id]) => displayName(conv.members.find((m) => m.id === id)));
  const memberById = new Map(conv.members.map((m) => [m.id, m]));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending.length, typers.length]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    store.send(conv.id, body);
    setDraft("");
    stick.current = true;
  };

  const online = others.filter((m) => state.presence[m.id]).length;
  const subtitle = peer
    ? peer.isBot
      ? "Demo bot, always online"
      : state.presence[peer.id]
        ? "Online"
        : "Offline"
    : `${conv.members.length} members, ${online} online`;

  return (
    <section className="conversation">
      <header className="conv-head">
        <button className="btn ghost icon back" onClick={props.onBack} aria-label="Back to conversations">‹</button>
        <Avatar name={title(conv, store.me)} bot={peer?.isBot} size={34} />
        <div className="conv-head-text">
          <div className="conv-title">
            {title(conv, store.me)}
            {peer?.isBot && <BotTag />}
          </div>
          <div className="muted small">{subtitle}</div>
        </div>
        <div className="spacer" />
        {conv.kind === "group" &&
          (adding ? (
            <AddMember store={store} conv={conv} onDone={() => setAdding(false)} />
          ) : (
            <button className="btn ghost small nowrap" onClick={() => setAdding(true)}>
              Add<span className="hide-sm"> people</span>
            </button>
          ))}
        <button className={`btn small nowrap hood-toggle ${props.inspectorOpen ? "on" : ""}`} onClick={props.onToggleInspector} aria-pressed={props.inspectorOpen}>
          <span className="hide-sm">Under the hood</span>
          <span className="show-sm">Inspect</span>
        </button>
      </header>

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {store.canLoadOlder(conv.id) && (
          <button className="btn ghost small load-older" onClick={() => void store.loadOlder(conv.id)}>Load earlier messages</button>
        )}
        {messages.map((m, i) => {
          const mine = m.senderId === store.me;
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const near = (a?: typeof m, b?: typeof m) =>
            !!a && !!b && a.senderId === b.senderId && Math.abs(Date.parse(a.createdAt) - Date.parse(b.createdAt)) < 5 * 60_000;
          const first = !near(prev, m);
          const last = !near(m, next) && !(mine && pending.length && i === messages.length - 1);
          const sender = memberById.get(m.senderId);
          const day = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const tick = !mine ? null : m.seq <= readUpTo ? "read" : m.seq <= deliveredUpTo ? "delivered" : "sent";
          return (
            <div key={m.seq} className="msg-wrap">
              {day && <div className="day">{dayLabel(m.createdAt)}</div>}
              <div className={`msg ${mine ? "mine" : "theirs"} ${first ? "first" : ""} ${last ? "last" : ""}`}>
                {!mine && conv.kind === "group" && (
                  <span className="msg-avatar">{last && <Avatar name={displayName(sender)} bot={sender?.isBot} size={26} />}</span>
                )}
                <div className="msg-col">
                  {!mine && conv.kind === "group" && first && (
                    <div className="msg-name">
                      {displayName(sender)}
                      {sender?.isBot && <BotTag />}
                    </div>
                  )}
                  <div className="bubble">
                    <span className="body">{m.body}</span>
                    <span className="meta">
                      {showSeq && <span className="seq">#{m.seq}</span>}
                      {time(m.createdAt)}
                      {tick && <Tick kind={tick} />}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {pending.map((p) => (
          <div key={p.clientMsgId} className="msg mine pending last">
            <div className="msg-col">
              <div className="bubble">
                <span className="body">{p.body}</span>
                <span className="meta">
                  {showSeq && <span className="seq">queued</span>}
                  <Tick kind="pending" />
                </span>
              </div>
            </div>
          </div>
        ))}
        {failed.map((f) => (
          <button key={f.clientMsgId} className="msg mine failed" onClick={() => store.dismissFailed(f.clientMsgId)}>
            <span className="bubble">Not sent: {f.message}. Tap to dismiss.</span>
          </button>
        ))}
      </div>

      <div className="typing" aria-live="polite">
        {typers.length > 0 && (
          <>
            <span className="typing-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            {typers.join(", ")} {typers.length > 1 ? "are" : "is"} typing
          </>
        )}
      </div>
      <form className="composer" onSubmit={submit}>
        <input
          value={draft}
          placeholder={peer?.username === "guide_bot" ? "Message the guide, or try /burst 40" : "Message"}
          maxLength={4000}
          aria-label="Message"
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value) store.client.typing(conv.id);
          }}
        />
        <button className="btn primary" disabled={!draft.trim()}>Send</button>
      </form>
    </section>
  );
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Tick({ kind }: { kind: "pending" | "sent" | "delivered" | "read" }) {
  const label = { pending: "Waiting to send", sent: "Sent", delivered: "Delivered", read: "Read" }[kind];
  if (kind === "pending") {
    return (
      <svg className="tick pending" viewBox="0 0 16 16" role="img" aria-label={label}>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className={`tick ${kind}`} viewBox="0 0 20 16" role="img" aria-label={label}>
      <path d="M2 8.5l3.5 3.5L12 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {kind !== "sent" && <path d="M8.5 12L16 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  );
}

// ---------------------------------------------------------------- under the hood

function Inspector(props: { store: ChatStore; state: ChatState; showSeq: boolean; onShowSeq: (v: boolean) => void; onClose: () => void }) {
  const { store, state } = props;
  const s = state.stats;
  const logRef = useRef<HTMLOListElement>(null);
  const followLog = useRef(true);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && followLog.current) el.scrollTop = el.scrollHeight;
  }, [state.log.length]);

  const offline = state.status === "closed";
  const counters: [string, number, string][] = [
    ["Delivered", s.delivered, "Messages handed to the app, once each"],
    ["Gaps repaired", s.gapRepairs, "Times the client noticed a missing number and fetched it"],
    ["Duplicates ignored", s.duplicatesIgnored, "Copies that arrived again and were dropped"],
    ["Resent", s.resends, "Unconfirmed sends sent again after reconnecting"],
    ["Lost on purpose", s.droppedSimulated, "Incoming messages thrown away by the simulator"],
    ["Reconnects", s.reconnects, "Times the connection was re-established"],
  ];

  return (
    <aside className="inspector" aria-label="Under the hood">
      <header className="insp-head">
        <h2>Under the hood</h2>
        <button className="btn ghost icon" onClick={props.onClose} aria-label="Close panel">×</button>
      </header>

      <section className="insp-section">
        <div className="conn-line">
          <ConnectionDot status={state.status} />
          {state.status === "ready" && (
            <span className="muted small">
              server <code>{state.nodeId}</code>
              {state.rtt !== null && <>, round trip {state.rtt} ms</>}
            </span>
          )}
        </div>
        <dl className="counters">
          {counters.map(([label, value, hint]) => (
            <div key={label} title={hint}>
              <dd>{value}</dd>
              <dt>{label}</dt>
            </div>
          ))}
        </dl>
      </section>

      <section className="insp-section">
        <h3>Try to break it</h3>
        <div className="chaos-buttons">
          <button className="btn small danger-outline" disabled={state.status !== "ready"} onClick={() => store.dropConnection()}>
            Drop connection
          </button>
          <button className="btn small" onClick={() => (offline ? store.goOnline() : store.goOffline())}>
            {offline ? "Go back online" : "Go offline"}
          </button>
        </div>
        <Switch checked={state.faults.loss} onChange={(loss) => store.setFaults({ ...state.faults, loss })}>
          Lose 30% of incoming messages
        </Switch>
        <Switch checked={state.faults.duplicate} onChange={(duplicate) => store.setFaults({ ...state.faults, duplicate })}>
          Duplicate incoming messages
        </Switch>
        <Switch checked={props.showSeq} onChange={props.onShowSeq}>
          Show sequence numbers
        </Switch>
        <p className="muted small">
          Every message still arrives once and in order. Sends made while offline wait in a queue and go out on reconnect.
        </p>
      </section>

      <section className="insp-section log-section">
        <div className="log-head">
          <h3>Live log</h3>
          <button className="btn ghost small" onClick={() => store.clearLog()}>Clear</button>
        </div>
        <ol
          className="log"
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            followLog.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
          }}
        >
          {state.log.length === 0 && <li className="muted log-empty">Send a message to see what happens.</li>}
          {state.log.map((l) => (
            <LogRow key={l.id} line={l} store={store} />
          ))}
        </ol>
      </section>
    </aside>
  );
}

function LogRow({ line, store }: { line: LogLine; store: ChatStore }) {
  const { label, detail, tone } = describe(line, store);
  const dir = line.dir === "out" ? "↑" : line.dir === "in" ? "↓" : "✕";
  return (
    <li className={`log-row ${line.dir} ${tone}`}>
      <span className="log-dir" aria-label={line.dir === "out" ? "sent" : line.dir === "in" ? "received" : "lost"}>{dir}</span>
      <span className="log-type">{label}</span>
      <span className="log-detail">{detail}</span>
    </li>
  );
}

function clip(s: string, n = 32): string {
  return s.length > n ? `“${s.slice(0, n - 1)}…”` : `“${s}”`;
}

function describe(line: LogLine, store: ChatStore): { label: string; detail: string; tone: string } {
  const f = line.frame as Record<string, any>;
  if (line.dir === "drop") return { label: "lost", detail: `#${f.msg?.seq} thrown away (simulated)`, tone: "bad" };
  switch (f.t) {
    case "auth":
      return { label: "auth", detail: "token sent (hidden here)", tone: "" };
    case "ready":
      return { label: "ready", detail: `connected to ${f.nodeId}, ${f.conversations?.length ?? 0} conversations`, tone: "good" };
    case "send":
      return { label: "send", detail: clip(f.body), tone: "" };
    case "sent":
      return { label: "sent", detail: `stored as #${f.seq}${f.duplicate ? ", was a retry" : ""}`, tone: "good" };
    case "message":
      return { label: "message", detail: `#${f.msg.seq} from ${store.nameOf(f.msg.senderId)}`, tone: "" };
    case "sync":
      return { label: "sync", detail: `gap found, asking for messages after #${f.afterSeq}`, tone: "repair" };
    case "sync_result": {
      const ms = f.messages as { seq: number }[];
      const range = ms.length ? ` (#${ms[0]!.seq}–#${ms[ms.length - 1]!.seq})` : "";
      return { label: "sync_result", detail: `${ms.length} message${ms.length === 1 ? "" : "s"}${range}`, tone: "repair" };
    }
    case "ack":
      return { label: "ack", detail: `${f.kind} up to #${f.seq}`, tone: "quiet" };
    case "receipt":
      return { label: "receipt", detail: `${store.nameOf(f.userId)} ${f.kind} up to #${f.seq}`, tone: "quiet" };
    case "typing":
      return { label: "typing", detail: line.dir === "in" ? store.nameOf(f.userId) : "you", tone: "quiet" };
    case "presence":
      return { label: "presence", detail: `${store.nameOf(f.userId)} ${f.online ? "online" : "offline"}`, tone: "quiet" };
    case "joined":
      return { label: "joined", detail: "added to a conversation", tone: "" };
    case "cursors":
      return { label: "cursors", detail: "server asked for a resync check", tone: "repair" };
    case "going_away":
      return { label: "going_away", detail: `server restarting, moving in ${f.reconnectInMs} ms`, tone: "repair" };
    case "error":
      return { label: "error", detail: f.message, tone: "bad" };
    default:
      return { label: f.t, detail: "", tone: "quiet" };
  }
}

// ---------------------------------------------------------------- dialogs

function useUserSearch(store: ChatStore, q: string) {
  const [results, setResults] = useState<{ id: string; username: string }[]>([]);
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        setResults((await api.searchUsers(store.token, q.trim().toLowerCase())).filter((u) => u.id !== store.me));
      } catch {
        setResults([]);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [q, store]);
  return results;
}

function NewConversation({ store, onClose, onCreated }: { store: ChatStore; onClose: () => void; onCreated: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const results = useUserSearch(store, q);

  const create = async () => {
    try {
      const { id } = await api.createConversation(store.token, picked, picked.length > 1 && name.trim() ? name.trim() : undefined);
      await store.loadConversations();
      onCreated(id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="New chat" onClick={(e) => e.stopPropagation()}>
        <h2>New chat</h2>
        <input autoFocus placeholder="Search people by username" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="pick-list">
          {results.length === 0 && (
            <li className="muted small">
              No one found. Use “Open a second user” in the sidebar to create someone to chat with.
            </li>
          )}
          {results.map((u) => (
            <li key={u.id}>
              <label>
                <input
                  type="checkbox"
                  checked={picked.includes(u.username)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, u.username] : picked.filter((p) => p !== u.username))}
                />
                <Avatar name={u.username} size={26} />
                {u.username}
              </label>
            </li>
          ))}
        </ul>
        {picked.length > 1 && <input placeholder="Group name (optional)" value={name} onChange={(e) => setName(e.target.value)} />}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!picked.length} onClick={create}>
            {picked.length > 1 ? "Start group" : "Start chat"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddMember({ store, conv, onDone }: { store: ChatStore; conv: Conversation; onDone: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.addMember(store.token, conv.id, name.trim().toLowerCase());
      await store.loadConversations();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="add-member" onSubmit={submit}>
      <input autoFocus placeholder="username" value={name} onChange={(e) => setName(e.target.value)} aria-label="Username to add" />
      <button className="btn small primary">Add</button>
      <button type="button" className="btn ghost small" onClick={onDone}>Cancel</button>
      {error && <span className="error small">{error}</span>}
    </form>
  );
}
