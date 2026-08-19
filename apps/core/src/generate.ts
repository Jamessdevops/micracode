/**
 * `POST /v1/generate` — the code-generation endpoint the web chat panels speak
 * (Vercel AI SDK UI Message Stream Protocol). It drives a pi coding-agent
 * session over the project workspace and translates pi's events into the exact
 * SSE frame contract the client was built against (see
 * apps/web/src/lib/api/uiMessage.ts and the old Python apps/api generate.py).
 *
 * Mapping:
 *   message_update/text_delta     -> text-start / text-delta / text-end
 *   tool write|edit (on success)  -> data-file-write {path, content}   (read from disk)
 *   tool bash (on start)          -> data-shell-exec {command, cwd}    (preview runtime runs it)
 *   other tools                   -> data-tool-call / data-tool-result (log rows)
 *
 * pi's default tool set has no question/todo tools, so those frames never fire;
 * the client tolerates their absence. Snapshots/revert aren't wired yet, so we
 * emit no snapshot_id (the Revert button stays hidden rather than 404-ing).
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import { Storage } from "./storage.js";

// pi pulls in undici 8.9, whose webidl does `markAsUncloneable = require(
// "node:worker_threads").markAsUncloneable` with no fallback (undici 6.x
// guards it with `|| (() => {})`). Electron's bundled Node doesn't expose that
// symbol, so undici captures `undefined` and every web object it builds
// (Response/EventSource/Headers) later throws "markAsUncloneable is not a
// function" — surfacing here as "session start failed". Backfill the no-op on
// the CJS worker_threads export before undici is ever required.
const workerThreads = createRequire(import.meta.url)("node:worker_threads");
if (typeof workerThreads.markAsUncloneable !== "function") {
  workerThreads.markAsUncloneable = () => {};
}

interface GenerateBody {
  project_id?: string;
  prompt?: string;
  retry?: boolean;
  // provider/model are accepted but ignored for now — pi resolves its own
  // default model/provider from env + ~/.pi/agent/auth.json. Wire an explicit
  // model here when the UI needs per-request override.
  provider?: string;
  model?: string;
}

const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// Micracode targets non-technical users: the agent must just build, not
// interview them about stacks. Every project is a Next.js (App Router) app
// pre-scaffolded with Tailwind (see starter.ts), so there is nothing to ask.
const SYSTEM_GUIDANCE = `You are building web apps for non-technical users inside Micracode. A live preview of the project renders next to this chat and reloads whenever you change files.

- The project is ALWAYS a Next.js (App Router) app with TypeScript and Tailwind, already scaffolded (package.json, app/layout.tsx, app/page.tsx, tailwind, lib/utils.ts with cn()). Build within it — never scaffold a new project or switch stack.
- ALWAYS build by writing and editing files with the write/edit tools, in this project directory. NEVER paste code, file contents, terminal commands, or snippets into the chat. NEVER produce a standalone script (no CLI/Node/readline programs) — everything is a web page/component the user sees in the preview.
- NEVER ask the user technical questions (framework, language, platform, tooling). They don't know or care. Assume a polished web app and just build it. E.g. "a calculator" means a calculator web UI in app/page.tsx, not a command-line program.
- When a request is ambiguous, make reasonable product choices and build the most useful version. Don't stall on clarification — ship something they can see, then let them refine it.
- Chat messages are short, plain-language, non-technical: say what you built or changed in a sentence or two, no code and no jargon. All the real output is the files you write and the running preview.`;

/** Minimal single-producer/single-consumer async frame queue. */
class FrameQueue {
  private items: unknown[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(frame: unknown): void {
    this.items.push(frame);
    this.wake?.();
    this.wake = null;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  async *drain(): AsyncGenerator<unknown> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift();
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

/** Best-effort extraction of a readable string from a pi tool result. */
function resultText(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> } | undefined;
  if (Array.isArray(r?.content)) {
    return r.content
      .map((p) => (p?.type === "text" ? (p.text ?? "") : ""))
      .join("");
  }
  return typeof result === "string" ? result : JSON.stringify(result ?? null);
}

export class Generator {
  // One pi session per project, reused across turns so context carries over.
  // ponytail: in-memory, single serial turn per project; lost on restart (the
  // assistant transcript is still persisted to prompts.jsonl and replayed into
  // the UI). Add a persistent SessionManager + per-project locking if follow-up
  // turns while a prior turn streams, or cross-restart memory, become needed.
  private sessions = new Map<string, AgentSession>();

  constructor(private readonly storage: Storage) {}

  private async ensureSession(projectId: string): Promise<AgentSession> {
    const existing = this.sessions.get(projectId);
    if (existing) return existing;
    const pi = await import("@earendil-works/pi-coding-agent");
    const modelRuntime = await pi.ModelRuntime.create();
    // pi loads credentials from its own store (~/.pi/agent/auth.json) and
    // ignores process.env, so the key the user configures in Settings (written
    // to ~/.micracode/auth.json and mirrored into env) never reaches it. Inject
    // it at runtime so our configured key wins over whatever pi has on file.
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) await modelRuntime.setRuntimeApiKey("openai", openaiKey);
    const workspace = this.storage.projectDir(projectId);
    // Steer pi via an appended system prompt so it just builds instead of
    // interviewing the user about stacks (see SYSTEM_GUIDANCE).
    const agentDir = pi.getAgentDir();
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      appendSystemPrompt: [SYSTEM_GUIDANCE],
    });
    await resourceLoader.reload();
    const { session } = await pi.createAgentSession({
      cwd: workspace,
      tools: TOOLS,
      modelRuntime,
      resourceLoader,
      sessionManager: pi.SessionManager.inMemory(workspace),
    });
    this.sessions.set(projectId, session);
    return session;
  }

  handle = async (c: Context): Promise<Response> => {
    const body = await c.req.json<GenerateBody>().catch(() => ({}) as GenerateBody);
    const projectId = body.project_id ?? "";
    const prompt = body.prompt ?? "";

    if (!this.storage.getProject(projectId)) {
      return c.json({ detail: "project not found" }, 404);
    }
    if (!body.retry) this.storage.appendPrompt(projectId, "user", prompt);

    const messageId = `msg_${Math.random().toString(36).slice(2, 18)}`;
    const textId = `txt_${Math.random().toString(36).slice(2, 18)}`;

    c.header("x-vercel-ai-ui-message-stream", "v1");
    c.header("Cache-Control", "no-cache, no-transform");

    return streamSSE(c, async (stream) => {
      const q = new FrameQueue();
      const ctx = { textStarted: false, buffer: [] as string[] };
      const calls = new Map<string, { toolName: string; args: any }>();

      const onEvent = (event: unknown) => {
        const e = event as Record<string, any>;
        switch (e?.type) {
          case "message_update": {
            const inner = e.assistantMessageEvent;
            if (inner?.type === "text_delta") {
              if (!ctx.textStarted) {
                ctx.textStarted = true;
                q.push({ type: "text-start", id: textId });
              }
              const delta = inner.delta ?? "";
              ctx.buffer.push(delta);
              q.push({ type: "text-delta", id: textId, delta });
            }
            break;
          }
          case "message_end": {
            // pi reports model failures (bad API key, rate limit, etc.) only
            // as a finished assistant message with stopReason "error" — it does
            // not throw or emit an error event. Without this the turn ends as a
            // silent empty "…" bubble. Surface it as an error frame.
            const m = e.message;
            if (m?.stopReason === "error" && m.errorMessage) {
              q.push({ type: "error", errorText: String(m.errorMessage) });
            }
            break;
          }
          case "tool_execution_start": {
            const toolName: string = e.toolName ?? "";
            const args = e.args ?? {};
            calls.set(e.toolCallId, { toolName, args });
            if (toolName === "write" || toolName === "edit") break; // -> file-write on end
            if (toolName === "bash") {
              q.push({
                type: "data-shell-exec",
                data: { command: args.command ?? args.cmd ?? "", cwd: args.cwd ?? null },
              });
            }
            q.push({
              type: "data-tool-call",
              data: { tool_call_id: e.toolCallId, tool_name: toolName, args, reason: "" },
            });
            break;
          }
          case "tool_execution_end": {
            const info = calls.get(e.toolCallId);
            if (!info) break;
            if (info.toolName === "write" || info.toolName === "edit") {
              if (e.isError) break;
              const rel = String(info.args.file_path ?? info.args.path ?? "")
                .replace(/\\/g, "/")
                .replace(/^\/+/, "");
              if (!rel) break;
              try {
                const content = fs.readFileSync(
                  path.join(this.storage.projectDir(projectId), rel),
                  "utf8",
                );
                q.push({ type: "data-file-write", id: rel, data: { path: rel, content } });
              } catch {
                // File vanished between write and read — skip the frame.
              }
              break;
            }
            q.push({
              type: "data-tool-result",
              data: {
                tool_call_id: e.toolCallId,
                tool_name: info.toolName,
                output: resultText(e.result),
                approved: !e.isError,
              },
            });
            break;
          }
        }
      };

      const session = await this.ensureSession(projectId).catch((err) => {
        q.push({ type: "error", errorText: `session start failed: ${err}` });
        return null;
      });

      const unsub = session?.subscribe(onEvent);

      q.push({ type: "start", messageId });
      q.push({ type: "start-step" });
      q.push({ type: "data-status", data: { stage: "generating" }, transient: true });

      // Drive the turn in the background; closing the queue ends the drain loop.
      const run = (async () => {
        try {
          if (session) {
            await session.prompt(prompt);
            await session.waitForIdle();
          }
        } catch (err) {
          q.push({ type: "error", errorText: String(err) });
        } finally {
          if (ctx.textStarted) q.push({ type: "text-end", id: textId });
          q.push({ type: "data-status", data: { stage: "done" }, transient: true });
          q.push({ type: "finish-step" });
          q.push({ type: "finish" });
          q.close();
        }
      })();

      for await (const frame of q.drain()) {
        await stream.writeSSE({ data: JSON.stringify(frame) });
      }
      await stream.writeSSE({ data: "[DONE]" });

      unsub?.();
      await run;

      const reply = ctx.buffer.join("").trim();
      if (reply) this.storage.appendPrompt(projectId, "assistant", reply);
    });
  };
}
