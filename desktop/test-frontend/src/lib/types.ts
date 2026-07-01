/**
 * Minimal wire types for the `micracode-api` read model. Kept local (rather than
 * importing `@micracode/shared`) so this test client stays standalone; they only
 * describe the fields this UI actually reads.
 */

export type Harness = "claude" | "codex";

export type Permission =
  | "bypassPermissions"
  | "acceptEdits"
  | "plan"
  | "default";

export interface HealthResponse {
  status: string;
  environment?: string;
  provider?: string;
  model?: string;
}

export type MessageRole = "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  text?: string;
  /** tool messages */
  name?: string;
  input?: unknown;
  result?: string | null;
  is_error?: boolean;
}

export interface Turn {
  status?: string;
  messages: Message[];
}

/** A thread summary (`GET /v1/threads`) or full thread (`GET /v1/threads/{id}`). */
export interface Thread {
  id: string;
  workspace?: string;
  status?: string;
  provider_session_id?: string;
  turns?: Turn[];
}

export interface SessionStartResponse {
  session_id: string;
}

export interface ConnState {
  online: boolean;
  text: string;
}
