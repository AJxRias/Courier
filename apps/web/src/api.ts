export interface Session {
  token: string;
  user: { id: string; username: string };
  /** Epoch ms when the token expires. */
  expiresAt: number;
}

export interface Member {
  id: string;
  username: string;
  readSeq: number;
  deliveredSeq: number;
}

export interface Conversation {
  id: string;
  title: string | null;
  kind: "direct" | "group";
  lastSeq: number;
  readSeq: number;
  updatedAt: string;
  members: Member[];
  lastMessage: { senderId: string; body: string; createdAt: string; seq: number } | null;
}

const KEY = "courier.session";

export function loadSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Session | null;
    return s && s.expiresAt > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  if (s) localStorage.setItem(KEY, JSON.stringify(s));
  else localStorage.removeItem(KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, opts: { token?: string; body?: unknown; method?: string } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText);
  return json as T;
}

export async function devLogin(username: string): Promise<Session> {
  const r = await request<{ token: string; user: Session["user"]; expiresIn: number }>("/api/auth/dev-login", {
    body: { username },
  });
  return { token: r.token, user: r.user, expiresAt: Date.now() + r.expiresIn * 1000 };
}

export async function refresh(s: Session): Promise<Session> {
  const r = await request<{ token: string; expiresIn: number }>("/api/auth/refresh", { token: s.token, body: {} });
  return { ...s, token: r.token, expiresAt: Date.now() + r.expiresIn * 1000 };
}

export const api = {
  conversations: (token: string) => request<Conversation[]>("/api/conversations", { token }),
  createConversation: (token: string, members: string[], title?: string) =>
    request<{ id: string }>("/api/conversations", { token, body: { members, title } }),
  addMember: (token: string, id: string, username: string) =>
    request<{ added: boolean }>(`/api/conversations/${id}/members`, { token, body: { username } }),
  history: (token: string, id: string, before?: number) =>
    request<import("@courier/client").ChatMessage[]>(
      `/api/conversations/${id}/messages?limit=50${before ? `&before=${before}` : ""}`,
      { token },
    ),
  presence: (token: string, userIds: string[]) =>
    request<Record<string, boolean>>(`/api/presence?userIds=${userIds.join(",")}`, { token }),
  searchUsers: (token: string, q: string) =>
    request<{ id: string; username: string }[]>(`/api/users?q=${encodeURIComponent(q)}`, { token }),
};
