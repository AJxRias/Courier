export interface PendingSend {
  clientMsgId: string;
  conversationId: string;
  body: string;
  /** Client clock, for display only. */
  createdAt: string;
}

/** What the client persists so it survives reloads without losing or repeating messages. */
export interface Snapshot {
  /** conversationId → highest seq delivered to the app in order. */
  cursors: Record<string, number>;
  /** Messages accepted by `send()` but not yet acknowledged by the server. */
  outbox: PendingSend[];
}

export interface ClientStorage {
  load(): Snapshot | null;
  save(snapshot: Snapshot): void;
}

export function memoryStorage(): ClientStorage {
  let snap: Snapshot | null = null;
  return {
    load: () => (snap ? structuredClone(snap) : null),
    save: (s) => (snap = structuredClone(s)),
  };
}

/** Browser storage keyed per user, so two accounts on one machine don't mix. */
export function localStorageStorage(key: string): ClientStorage {
  return {
    load() {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? (JSON.parse(raw) as Snapshot) : null;
      } catch {
        return null;
      }
    },
    save(s) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(s));
      } catch {
        // Quota exceeded or storage disabled: keep working in memory.
      }
    },
  };
}
