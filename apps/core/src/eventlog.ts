/**
 * The append-only event log backing `/v1/events` and `/v1/events/stream`.
 *
 * Every state change the engine makes becomes one `StoredEvent` with a global,
 * monotonically increasing `seq`. Clients replay from a cursor and then follow
 * the live SSE stream. Matches the ts-rs `StoredEvent` / `EventsPage` shapes in
 * `apps/web/src/lib/api/generated/`.
 *
 * in-memory only — the log resets on restart. Swap the array for a
 * SQLite/JSONL-backed store if threads must survive an app relaunch.
 */

export interface StoredEvent {
  seq: number;
  kind: string;
  payload: unknown;
}

export interface EventsPage {
  events: StoredEvent[];
  cursor: number;
}

type Listener = (event: StoredEvent) => void;

export class EventLog {
  private events: StoredEvent[] = [];
  private listeners = new Set<Listener>();

  append(kind: string, payload: unknown): StoredEvent {
    const event: StoredEvent = { seq: this.events.length + 1, kind, payload };
    this.events.push(event);
    for (const l of this.listeners) l(event);
    return event;
  }

  /** Everything strictly after `cursor`, plus the new cursor to resume from. */
  since(cursor: number): EventsPage {
    const events = this.events.filter((e) => e.seq > cursor);
    return { events, cursor: this.events.length };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
