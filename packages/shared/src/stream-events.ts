/**
 * Wire contract between the core backend and the Next.js frontend.
 *
 * The backend emits one `StreamEvent` per SSE `data:` frame as compact JSON.
 * A terminal `event: end` frame signals the end of the stream.
 */

export type StreamStage = "planning" | "generating" | "done" | "cancelled" | "plan_ready";

/** Incremental chat text from the assistant. */
export interface MessageDeltaEvent {
  type: "message.delta";
  content: string;
}

/** Create or overwrite a file in the virtual file system. */
export interface FileWriteEvent {
  type: "file.write";
  path: string;
  content: string;
}

/** Remove a file from the virtual file system. */
export interface FileDeleteEvent {
  type: "file.delete";
  path: string;
}

/** Request a shell command be executed inside the sandbox (WebContainer). */
export interface ShellExecEvent {
  type: "shell.exec";
  command: string;
  cwd?: string;
}

/** High-level lifecycle marker, useful for UI affordances. */
export interface StatusEvent {
  type: "status";
  stage: StreamStage;
  note?: string;
  /**
   * On `stage: "generating"`, the id of the pre-turn snapshot captured
   * just before this turn's first file write. Lets the UI attach a
   * "revert to before this message" action to the assistant reply.
   */
  snapshot_id?: string;
}

/** Stream-level error. If `recoverable` is true the stream may continue. */
export interface ErrorEvent {
  type: "error";
  message: string;
  recoverable: boolean;
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** A single entry in the agent's session checklist. */
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/**
 * Full snapshot of the agent's todo list, emitted whenever it changes.
 * The list is sent in its entirety (not as a delta), so the UI renders the
 * current checklist by replacing whatever it last had.
 */
export interface TodoUpdateEvent {
  type: "todo.update";
  todos: TodoItem[];
}

export type StreamEvent =
  | MessageDeltaEvent
  | FileWriteEvent
  | FileDeleteEvent
  | ShellExecEvent
  | StatusEvent
  | ErrorEvent
  | TodoUpdateEvent;

export type StreamEventType = StreamEvent["type"];

/**
 * Type guard that narrows a parsed unknown value to a concrete `StreamEvent`.
 * Intentionally permissive about unknown future fields (forward compatibility)
 * while strict about required discriminators.
 */
export function isStreamEvent(value: unknown): value is StreamEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { type?: unknown };
  if (typeof v.type !== "string") return false;

  switch (v.type) {
    case "message.delta":
      return typeof (value as MessageDeltaEvent).content === "string";
    case "file.write": {
      const e = value as FileWriteEvent;
      return typeof e.path === "string" && typeof e.content === "string";
    }
    case "file.delete":
      return typeof (value as FileDeleteEvent).path === "string";
    case "shell.exec":
      return typeof (value as ShellExecEvent).command === "string";
    case "status": {
      const e = value as StatusEvent;
      return (
        e.stage === "planning" ||
        e.stage === "generating" ||
        e.stage === "done" ||
        e.stage === "cancelled" ||
        e.stage === "plan_ready"
      );
    }
    case "error": {
      const e = value as ErrorEvent;
      return typeof e.message === "string" && typeof e.recoverable === "boolean";
    }
    case "todo.update":
      return Array.isArray((value as TodoUpdateEvent).todos);
    default:
      return false;
  }
}
