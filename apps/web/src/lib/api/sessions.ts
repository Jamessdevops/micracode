/**
 * Agent session client (`/v1/sessions`): start a harness in a workspace, send
 * turns, interrupt, stop. Session output arrives on the event stream.
 */

import { type ApiClientOptions, request } from "./projects";

export type Harness = "codex" | "claude";

export interface StartSessionBody {
  /** The project whose folder the agent works in (required). */
  project_id: string;
  model?: string;
  harness?: Harness;
}

export interface StartSessionResponse {
  session_id: string;
  harness: Harness;
}

export function startSession(
  body: StartSessionBody,
  opts?: ApiClientOptions,
): Promise<StartSessionResponse> {
  return request<StartSessionResponse>(
    "/v1/sessions",
    { method: "POST", body: JSON.stringify(body) },
    opts,
  );
}

export function sendTurn(
  sessionId: string,
  text: string,
  opts?: ApiClientOptions,
): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/turn`,
    { method: "POST", body: JSON.stringify({ text }) },
    opts,
  );
}

export function resumeSession(
  sessionId: string,
  opts?: ApiClientOptions,
): Promise<StartSessionResponse> {
  return request<StartSessionResponse>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/resume`,
    { method: "POST", body: "{}" },
    opts,
  );
}

export function interruptSession(
  sessionId: string,
  opts?: ApiClientOptions,
): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/interrupt`,
    { method: "POST", body: "{}" },
    opts,
  );
}

export function stopSession(
  sessionId: string,
  opts?: ApiClientOptions,
): Promise<{ stopped: boolean }> {
  return request<{ stopped: boolean }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
    opts,
  );
}
