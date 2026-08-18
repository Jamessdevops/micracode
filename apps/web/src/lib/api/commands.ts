/**
 * Command dispatch + event log client for the Rust engine (`/v1/commands`,
 * `/v1/events`). Commands are idempotent by `id`; every state change comes
 * back as an event on the SSE stream.
 */

import { env } from "@/lib/env";

import { type ApiClientOptions, request } from "./projects";
import type { EventsPage } from "./generated/EventsPage";
import type { StoredEvent } from "./generated/StoredEvent";

export type { EventsPage, StoredEvent };

export interface CommandRequest {
  /** Idempotency key. */
  id: string;
  kind: string;
  payload?: unknown;
}

export function dispatchCommand(
  body: CommandRequest,
  opts?: ApiClientOptions,
): Promise<unknown> {
  return request<unknown>(
    "/v1/commands",
    { method: "POST", body: JSON.stringify(body) },
    opts,
  );
}

export function listEvents(
  cursor = 0,
  opts?: ApiClientOptions,
): Promise<EventsPage> {
  return request<EventsPage>(`/v1/events?cursor=${cursor}`, { method: "GET" }, opts);
}

/**
 * Subscribe to the live event stream, replaying everything after `cursor`
 * first. Returns an unsubscribe function.
 */
export function streamEvents(
  onEvent: (event: StoredEvent) => void,
  cursor = 0,
  opts?: { baseUrl?: string; onError?: (err: Event) => void },
): () => void {
  const base = opts?.baseUrl ?? env.API_BASE_URL;
  const source = new EventSource(`${base}/v1/events/stream?cursor=${cursor}`);
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as StoredEvent);
    } catch {
      // Ignore keep-alive comments and any malformed frame.
    }
  };
  if (opts?.onError) source.onerror = opts.onError;
  return () => source.close();
}
