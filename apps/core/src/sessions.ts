/**
 * Session manager: each session is one pi coding-agent run bound to a project
 * workspace. pi's streamed events are translated into event-log entries so the
 * web client picks them up over `/v1/events/stream`.
 *
 * pi API used (see https://pi.dev/docs/latest/sdk):
 *   createAgentSession({ cwd, tools, modelRuntime, sessionManager, model? })
 *   session.subscribe(cb) / session.prompt(text) / session.abort()
 *
 * pi's event field names are mapped defensively (optional chaining) —
 * if the installed SDK shapes differ, adjust `mapPiEvent` only.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { EventLog } from "./eventlog.js";
import { Storage } from "./storage.js";

export type Harness = "codex" | "claude";
export type PermissionMode = "bypassPermissions" | "acceptEdits" | "plan" | "default";

export interface StartSessionBody {
  project_id?: string;
  workspace?: string;
  model?: string;
  harness?: Harness;
  permission?: PermissionMode;
}

export interface StartSessionResponse {
  session_id: string;
  harness: Harness;
  permission: PermissionMode;
}

interface LiveSession {
  id: string;
  workspace: string;
  harness: Harness;
  permission: PermissionMode;
  pi: AgentSession;
}

const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export class SessionManager {
  private sessions = new Map<string, LiveSession>();

  constructor(
    private readonly log: EventLog,
    private readonly storage: Storage,
  ) {}

  private resolveWorkspace(body: StartSessionBody): string {
    if (body.project_id) {
      const rec = this.storage.getProject(body.project_id);
      if (!rec) throw new Error(`project not found: ${body.project_id}`);
      return this.storage.projectDir(body.project_id);
    }
    if (body.workspace) return body.workspace;
    throw new Error("project_id or workspace is required");
  }

  async start(body: StartSessionBody): Promise<StartSessionResponse> {
    const workspace = this.resolveWorkspace(body);
    const harness: Harness = body.harness ?? "claude";
    // permission modes aren't enforced yet — the agent runs its tools
    // without an approval round-trip. Wire pi's interactive-approval hook (or a
    // custom bash tool that emits a `tool.permission_request` event and waits)
    // when the UI needs a confirm step.
    const permission: PermissionMode = body.permission ?? "bypassPermissions";
    const id = `sess_${Math.random().toString(36).slice(2, 12)}`;

    // `body.model` is currently ignored — pi resolves its own default
    // model/provider from env + ~/.pi/agent/auth.json. Wire an explicit model
    // (Models.getModel from pi-ai) here when the UI needs per-session override.
    const pi = await import("@earendil-works/pi-coding-agent");
    const modelRuntime = await pi.ModelRuntime.create();

    const { session } = await pi.createAgentSession({
      cwd: workspace,
      tools: TOOLS,
      modelRuntime,
      sessionManager: pi.SessionManager.inMemory(workspace),
    });

    session.subscribe((event) => this.mapPiEvent(id, event));

    this.sessions.set(id, { id, workspace, harness, permission, pi: session });
    this.log.append("session.started", { session_id: id, workspace, harness });
    return { session_id: id, harness, permission };
  }

  turn(id: string, text: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.workspace) {
      // Persist the user turn against the project so reopening replays it.
      const projectId = this.projectIdFor(s.workspace);
      if (projectId) this.storage.appendPrompt(projectId, "user", text);
    }
    this.log.append("turn.user", { session_id: id, text });
    void Promise.resolve(s.pi.prompt(text)).catch((err) =>
      this.log.append("error", { session_id: id, message: String(err) }),
    );
    return true;
  }

  interrupt(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    void Promise.resolve(s.pi.abort());
    this.log.append("turn.interrupted", { session_id: id });
    return true;
  }

  stop(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    void Promise.resolve(s.pi.abort());
    this.sessions.delete(id);
    this.log.append("session.closed", { session_id: id });
    return true;
  }

  info(id: string): StartSessionResponse | null {
    const s = this.sessions.get(id);
    return s ? { session_id: s.id, harness: s.harness, permission: s.permission } : null;
  }

  private projectIdFor(workspace: string): string | null {
    const id = workspace.split(/[/\\]/).filter(Boolean).pop() ?? null;
    return id && this.storage.getProject(id) ? id : null;
  }

  /** Translate one pi event into an event-log entry. */
  private mapPiEvent(sessionId: string, event: unknown): void {
    const e = event as Record<string, any>;
    const base = { session_id: sessionId };
    switch (e?.type) {
      case "message_update": {
        const inner = e.assistantMessageEvent ?? {};
        if (inner.type === "text_delta")
          this.log.append("message.delta", { ...base, delta: inner.delta ?? "" });
        else if (inner.type === "thinking_delta")
          this.log.append("thinking.delta", { ...base, delta: inner.delta ?? "" });
        break;
      }
      case "tool_execution_start":
        this.log.append("tool.start", { ...base, tool_name: e.toolName ?? e.tool_name });
        break;
      case "tool_execution_update":
        this.log.append("tool.update", { ...base, output: e.output ?? e.delta });
        break;
      case "tool_execution_end":
        this.log.append("tool.end", { ...base, is_error: Boolean(e.isError ?? e.is_error) });
        break;
      case "turn_start":
        this.log.append("turn.start", base);
        break;
      case "turn_end":
        this.log.append("turn.end", { ...base, result: e.result ?? e.message?.text });
        break;
      case "agent_end":
        this.log.append("turn.quiescent", base);
        break;
      default:
        // Unmapped lifecycle events (message_start/end, queue_update,
        // compaction_*) are dropped — add cases as the UI needs them.
        break;
    }
  }
}
