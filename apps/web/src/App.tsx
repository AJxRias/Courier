import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { api, devLogin, loadSession, saveSession, type Conversation, type Session } from "./api";
import { ChatStore } from "./store";

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const store = useMemo(() => (session ? new ChatStore(session, () => setSession(null)) : null), [session]);
  useEffect(() => {
    store?.client.connect();
    return () => store?.client.close();
  }, [store]);
  if (!session || !store) return <Login onLogin={(s) => (saveSession(s), setSession(s))} />;
  return <Shell store={store} />;
}

// ---------------------------------------------------------------- login

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onLogin(await devLogin(name.trim().toLowerCase()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark" />
          Courier
        </div>
        <p className="muted">Real-time chat with exactly-once, in-order delivery. Pick any username to try it; open a second window as someone else.</p>
        <input autoFocus placeholder="username" value={name} onChange={(e) => setName(e.target.value)} pattern="[a-zA-Z0-9_]{3,32}" required />
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? "Signing in…" : "Continue"}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- shell

function Shell({ store }: { store: ChatStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [active, setActive] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showSeq, setShowSeq] = useState(false);
  const conv = state.conversations.find((c) => c.id === active) ?? null;

  useEffect(() => {
    if (active) void store.open(active);
  }, [active, store]);

  return (
    <div className={`app ${active ? "has-active" : ""}`}>
      <aside className="sidebar">
        <header className="sidebar-head">
          <div className="brand small">
            <span className="brand-mark" />
            Courier
          </div>
          <button className="ghost" onClick={() => setShowNew(true)} title="New conversation">
            + New
          </button>
          <button className="ghost" onClick={() => store.logout()}>Log out</button>
        </header>
        <ul className="conv-list">
          {state.conversations.length === 0 && <li className="empty muted">No conversations yet. Start one with “+ New”.</li>}
          {state.conversations.map((c) => (
            <ConversationRow key={c.id} c={c} me={store.me} active={c.id === active} presence={state.presence} onClick={() => setActive(c.id)} />
          ))}
        </ul>
        <footer className="sidebar-foot">
          <ConnectionPill status={state.status} nodeId={state.nodeId} rtt={state.rtt} pending={store.client.pending().length} />
          <div className="foot-row">
            <span className="me">@{store.username}</span>
            <label className="toggle">
              <input type="checkbox" checked={showSeq} onChange={(e) => setShowSeq(e.target.checked)} /> seq
            </label>
            {state.status === "closed" ? (
              <button className="ghost" onClick={() => store.goOnline()}>Go online</button>
            ) : (
              <button className="ghost" onClick={() => store.goOffline()} title="Disconnect to see offline queueing">Go offline</button>
            )}
          </div>
        </footer>
      </aside>
      <main className="main">
        {conv ? (
          <ConversationView key={conv.id} store={store} conv={conv} showSeq={showSeq} onBack={() => setActive(null)} />
        ) : (
          <div className="placeholder muted">Select a conversation</div>
        )}
      </main>
      {showNew && <NewConversation store={store} onClose={() => setShowNew(false)} onCreated={(id) => (setShowNew(false), setActive(id))} />}
    </div>
  );
}

function title(c: Conversation, me: string): string {
  return c.title ?? (c.members.filter((m) => m.id !== me).map((m) => m.username).join(", ") || "Just you");
}

function ConversationRow(props: { c: Conversation; me: string; active: boolean; presence: Record<string, boolean>; onClick: () => void }) {
  const { c, me } = props;
  const unread = Math.max(0, c.lastSeq - c.readSeq);
  const others = c.members.filter((m) => m.id !== me);
  const online = c.kind === "direct" && others[0] && props.presence[others[0].id];
  const who = c.lastMessage ? (c.lastMessage.senderId === me ? "You: " : c.kind === "group" ? `${c.members.find((m) => m.id === c.lastMessage!.senderId)?.username ?? ""}: ` : "") : "";
  return (
    <li className={`conv-row ${props.active ? "active" : ""}`} onClick={props.onClick}>
      <div className="avatar">
        {title(c, me).slice(0, 1).toUpperCase()}
        {online && <span className="dot" />}
      </div>
      <div className="conv-text">
        <div className="conv-title">{title(c, me)}</div>
        <div className="conv-preview muted">{c.lastMessage ? who + c.lastMessage.body : "No messages yet"}</div>
      </div>
      {unread > 0 && !props.active && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
    </li>
  );
}

function ConnectionPill({ status, nodeId, rtt, pending }: { status: string; nodeId: string; rtt: number | null; pending: number }) {
  const label = status === "ready" ? "Live" : status === "closed" ? "Offline (manual)" : status === "offline" ? "Reconnecting…" : "Connecting…";
  return (
    <div className={`pill pill-${status}`}>
      <span className="pill-dot" />
      <span>{label}</span>
      {status === "ready" && (
        <span className="mono muted">
          {nodeId}
          {rtt !== null ? ` · ${rtt}ms` : ""}
        </span>
      )}
      {pending > 0 && <span className="mono">· {pending} queued</span>}
    </div>
  );
}

// ---------------------------------------------------------------- conversation

function ConversationView({ store, conv, showSeq, onBack }: { store: ChatStore; conv: Conversation; showSeq: boolean; onBack: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const messages = store.messagesFor(conv.id);
  const pending = store.pendingFor(conv.id);
  const failed = state.failed.filter((f) => f.conversationId === conv.id);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const others = conv.members.filter((m) => m.id !== store.me);
  const readUpTo = Math.max(0, ...others.map((m) => m.readSeq));
  const deliveredUpTo = Math.max(0, ...others.map((m) => m.deliveredSeq));
  const typers = Object.entries(state.typing[conv.id] ?? {})
    .filter(([, exp]) => exp > Date.now())
    .map(([id]) => conv.members.find((m) => m.id === id)?.username)
    .filter(Boolean);

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

  return (
    <section className="conversation">
      <header className="conv-head">
        <button className="ghost back" onClick={onBack}>←</button>
        <div>
          <div className="conv-title">{title(conv, store.me)}</div>
          <div className="muted small">
            {conv.kind === "direct" ? (online ? "online" : "offline") : `${conv.members.length} members · ${online} online`}
          </div>
        </div>
        <div className="spacer" />
        {adding ? (
          <AddMember store={store} conv={conv} onDone={() => setAdding(false)} />
        ) : (
          <button className="ghost" onClick={() => setAdding(true)}>Add people</button>
        )}
      </header>

      <div className="messages" ref={scroller} onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}>
        {store.canLoadOlder(conv.id) && (
          <button className="ghost load-older" onClick={() => void store.loadOlder(conv.id)}>Load older messages</button>
        )}
        {messages.map((m, i) => {
          const mine = m.senderId === store.me;
          const prev = messages[i - 1];
          const showName = !mine && conv.kind === "group" && prev?.senderId !== m.senderId;
          const tick = !mine ? null : m.seq <= readUpTo ? "read" : m.seq <= deliveredUpTo ? "delivered" : "sent";
          return (
            <div key={m.seq} className={`msg ${mine ? "mine" : ""}`}>
              {showName && <div className="msg-name">{conv.members.find((u) => u.id === m.senderId)?.username}</div>}
              <div className="bubble">
                <span className="body">{m.body}</span>
                <span className="meta">
                  {showSeq && <span className="mono">#{m.seq} </span>}
                  {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  {tick && <Tick kind={tick} />}
                </span>
              </div>
            </div>
          );
        })}
        {pending.map((p) => (
          <div key={p.clientMsgId} className="msg mine pending">
            <div className="bubble">
              <span className="body">{p.body}</span>
              <span className="meta">
                {showSeq && <span className="mono">queued </span>}
                <Tick kind="pending" />
              </span>
            </div>
          </div>
        ))}
        {failed.map((f) => (
          <div key={f.clientMsgId} className="msg mine failed" onClick={() => store.dismissFailed(f.clientMsgId)}>
            <div className="bubble">
              <span className="body">Not sent: {f.message} (tap to dismiss)</span>
            </div>
          </div>
        ))}
      </div>

      <div className="typing muted small">{typers.length ? `${typers.join(", ")} ${typers.length > 1 ? "are" : "is"} typing…` : " "}</div>
      <form className="composer" onSubmit={submit}>
        <input
          value={draft}
          placeholder="Message"
          maxLength={4000}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value) store.client.typing(conv.id);
          }}
        />
        <button className="primary" disabled={!draft.trim()}>Send</button>
      </form>
    </section>
  );
}

function Tick({ kind }: { kind: "pending" | "sent" | "delivered" | "read" }) {
  const label = { pending: "Waiting to send", sent: "Sent", delivered: "Delivered", read: "Read" }[kind];
  if (kind === "pending") {
    return (
      <svg className="tick pending" viewBox="0 0 16 16" aria-label={label}>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className={`tick ${kind}`} viewBox="0 0 20 16" aria-label={label}>
      <path d="M2 8.5l3.5 3.5L12 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {kind !== "sent" && <path d="M8 12l1 0L16 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New conversation</h3>
        <input autoFocus placeholder="Search usernames" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="pick-list">
          {results.length === 0 && <li className="muted small">No users found. Ask a friend to sign in first.</li>}
          {results.map((u) => (
            <li key={u.id}>
              <label>
                <input
                  type="checkbox"
                  checked={picked.includes(u.username)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, u.username] : picked.filter((p) => p !== u.username))}
                />
                {u.username}
              </label>
            </li>
          ))}
        </ul>
        {picked.length > 1 && <input placeholder="Group name (optional)" value={name} onChange={(e) => setName(e.target.value)} />}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!picked.length} onClick={create}>
            Start {picked.length > 1 ? "group" : "chat"}
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
      <input autoFocus placeholder="username" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="primary">Add</button>
      <button type="button" className="ghost" onClick={onDone}>×</button>
      {error && <span className="error small">{error}</span>}
    </form>
  );
}
