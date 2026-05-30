import type { UIMessage } from "ai";

import type { PromptRecord } from "./projects";

/**
 * Custom data part payloads emitted by our FastAPI `/v1/generate`
 * endpoint over the Vercel AI SDK UI Message Stream Protocol.
 *
 * The keys become `data-<key>` part types on the wire; the values are
 * the shape of the `data` field.
 */
export type MicracodeDataParts = {
  "file-write": { path: string; content: string };
  "file-delete": { path: string };
  status: {
    stage: "planning" | "generating" | "done" | "cancelled" | "plan_ready";
    note?: string | null;
    snapshot_id?: string | null;
  };
  "shell-exec": { command: string; cwd?: string | null };
  "tool-call": {
    tool_call_id: string;
    tool_name: string;
    args: Record<string, unknown>;
    reason: string;
  };
  "tool-result": {
    tool_call_id: string;
    tool_name: string;
    output: string;
    approved: boolean;
  };
  "tool-permission-request": {
    tool_call_id: string;
    command: string;
    reason: string;
    request_id: string;
  };
  "tool-denied": { tool_call_id: string };
  "tool-question": {
    tool_call_id: string;
    question: string;
    options: string[];
    request_id: string;
  };
};

export interface MicracodeMessageMetadata {
  /**
   * For assistant messages: id of the pre-turn snapshot captured
   * just before this turn ran. Lets the UI offer "revert to before
   * this message".
   */
  snapshot_id?: string | null;
}

export type MicracodeUIMessage = UIMessage<
  MicracodeMessageMetadata,
  MicracodeDataParts
>;

/**
 * Convert persisted prompts (loaded via `GET /v1/projects/:id/prompts`)
 * into AI SDK `UIMessage[]` so we can pre-seed `useChat`.
 */
export function promptsToUIMessages(
  prompts: PromptRecord[] | undefined,
): MicracodeUIMessage[] {
  if (!prompts || prompts.length === 0) return [];
  const messages: MicracodeUIMessage[] = [];
  for (const p of prompts) {
    if (p.role !== "user" && p.role !== "assistant") continue;
    messages.push({
      id: p.id,
      role: p.role,
      parts: [{ type: "text", text: p.content, state: "done" }],
      metadata:
        p.role === "assistant" && p.snapshot_id
          ? { snapshot_id: p.snapshot_id }
          : undefined,
    });
  }
  return messages;
}

/**
 * Extract the plain-text content of a UI message by concatenating all
 * of its text parts (the server's patch bundles live in data parts, so
 * they don't leak into the chat transcript this way).
 */
export function messageText(message: MicracodeUIMessage): string {
  let out = "";
  for (const part of message.parts) {
    if (part.type === "text") out += part.text;
  }
  return out;
}
