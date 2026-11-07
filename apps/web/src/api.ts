import type { ChatMessage } from "@courier/client";

export interface Session {
  token: string;
  user: { id: string; username: string };
  /** Epoch ms when the token expires. */
  expiresAt: number;
}

export interface Member {
  id: string;
  username: string;
  isBot: boolean;
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

/**
 * "Second user" tabs (opened with ?guest=1) keep their session in
 * sessionStorage, so two tabs in one browser can be two different people.
 */
const params = new URLSearchParams(location.search);
export const isGuestTab = params.has("guest");
export const chatWithParam = params.get("with");
export const tabStorage: Storage = isGuestTab ? sessionStorage : localStorage;

const KEY = "courier.session";

export function loadSession(): Session | null {
  try {
    const s = JSON.parse(tabStorage.getItem(KEY) ?? "null") as Session | null;
    return s && s.expiresAt > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  if (s) tabStorage.setItem(KEY, JSON.stringify(s));
  else tabStorage.removeItem(KEY);
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

export function guestName(): string {
  return `guest_${Math.random().toString(36).slice(2, 8)}`;
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
    request<ChatMessage[]>(`/api/conversations/${id}/messages?limit=50${before ? `&before=${before}` : ""}`, { token }),
  presence: (token: string, userIds: string[]) =>
    request<Record<string, boolean>>(`/api/presence?userIds=${userIds.join(",")}`, { token }),
  searchUsers: (token: string, q: string) =>
    request<{ id: string; username: string }[]>(`/api/users?q=${encodeURIComponent(q)}`, { token }),
  startDemo: (token: string) => request<{ dm: string; room: string }>("/api/demo/start", { token, body: {} }),
};

/** Bots are named like "maya_bot"; show them as "maya". */
export function displayName(m: { username: string; isBot?: boolean } | undefined): string {
  if (!m) return "someone";
  return m.isBot ? m.username.replace(/_bot$/, "") : m.username;
}
