type Listener<A extends unknown[]> = (...args: A) => void;

/** Minimal typed event emitter that works in browsers and Node. */
export class Emitter<Events extends Record<string, unknown[]>> {
  private listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    (this.listeners[event] ??= new Set()).add(fn);
    return () => this.off(event, fn);
  }

  off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
    this.listeners[event]?.delete(fn);
  }

  protected emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    for (const fn of this.listeners[event] ?? []) {
      try {
        fn(...args);
      } catch (err) {
        // A broken listener must not break the client's state machine.
        console.error(`courier: listener for "${String(event)}" threw`, err);
      }
    }
  }
}
