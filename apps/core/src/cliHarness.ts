/**
 * CLI agent backends: spawn the user's locally-installed `claude` / `codex`
 * CLI as the coding agent (like conductor.build wraps Claude Code), and adapt
 * its streamed output into the SAME pi-shaped events generate.ts already maps
 * to UI frames. Nothing here builds UI frames — generate.ts's onEvent does.
 *
 * The event shapes yielded here mirror the subset of pi events generate.ts
 * consumes: `message_update`(text_delta), `tool_execution_start`,
 * `tool_execution_end`, `message_end`(stopReason "error"). Fields are read
 * defensively (optional chaining) because CLI JSON schemas drift between
 * versions — same posture as sessions.ts's pi mapper.
 */

import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";

export type PiShapedEvent = Record<string, any>;

export interface CliRunOpts {
  bin: "claude" | "codex";
  workspace: string;
  prompt: string;
  model?: string;
  /** claude permission mode; values already match claude's flag. */
  permission?: string;
  /** Prior CLI session id to `--resume` so context carries across turns. */
  resumeId?: string;
  /** Called with the CLI's session id (for the next turn's resume). */
  onMeta?: (sessionId: string) => void;
}

const availCache = new Map<string, boolean>();

/** Is `bin` resolvable on PATH? Cached per process. */
export function cliAvailable(bin: string): boolean {
  const hit = availCache.get(bin);
  if (hit !== undefined) return hit;
  const probe = process.platform === "win32" ? "where" : "which";
  const ok = spawnSync(probe, [bin], { stdio: "ignore" }).status === 0;
  availCache.set(bin, ok);
  return ok;
}

const LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

function errorEvent(message: string): PiShapedEvent {
  return {
    type: "message_end",
    message: { stopReason: "error", errorMessage: message },
  };
}

function spawnErrMessage(bin: string, err: NodeJS.ErrnoException): string {
  const label = LABEL[bin] ?? bin;
  if (err?.code === "ENOENT")
    return `${label} CLI not found on PATH. Install it and sign in, then pick it again.`;
  return `${label} CLI failed to start: ${err?.message ?? err}`;
}

function claudeArgs(o: CliRunOpts): string[] {
  return [
    "-p",
    o.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    o.permission ?? "bypassPermissions",
    ...(o.model ? ["--model", o.model] : []),
    ...(o.resumeId ? ["--resume", o.resumeId] : []),
  ];
}

const TOOL_ALIAS: Record<string, string> = {
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  Bash: "bash",
};
const mapTool = (name: string): string =>
  TOOL_ALIAS[name] ?? name.toLowerCase();

/**
 * Parse one NDJSON line into zero or more pi-shaped events. `workspace` is the
 * project dir: claude reports absolute `file_path`s, but generate.ts's
 * file-write handler expects a workspace-relative path, so we relativize here.
 */
export function mapClaudeLine(
  line: string,
  workspace: string,
  onMeta?: (id: string) => void,
): PiShapedEvent[] {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return []; // non-JSON noise (banners, warnings)
  }
  switch (obj?.type) {
    case "system":
      if (obj.subtype === "init" && obj.session_id) onMeta?.(obj.session_id);
      return [];
    case "assistant": {
      const out: PiShapedEvent[] = [];
      for (const b of obj.message?.content ?? []) {
        if (b?.type === "text")
          out.push({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: b.text ?? "" },
          });
        else if (b?.type === "tool_use") {
          // claude tool input uses `file_path` / `command` — the exact keys
          // generate.ts reads — but file_path is absolute; make it relative.
          const args = { ...(b.input ?? {}) };
          if (
            typeof args.file_path === "string" &&
            path.isAbsolute(args.file_path) &&
            workspace
          )
            args.file_path = path.relative(workspace, args.file_path);
          out.push({
            type: "tool_execution_start",
            toolName: mapTool(b.name ?? ""),
            toolCallId: b.id,
            args,
          });
        }
      }
      return out;
    }
    case "user": {
      const out: PiShapedEvent[] = [];
      for (const b of obj.message?.content ?? []) {
        if (b?.type === "tool_result")
          out.push({
            type: "tool_execution_end",
            toolCallId: b.tool_use_id,
            isError: Boolean(b.is_error),
            result: b.content,
          });
      }
      return out;
    }
    case "result":
      if (obj.session_id) onMeta?.(obj.session_id);
      if (obj.is_error || (obj.subtype && obj.subtype !== "success"))
        return [errorEvent(String(obj.result ?? obj.subtype ?? "agent error"))];
      return [];
    default:
      return [];
  }
}

// ponytail: Codex mapping is UNVERIFIED — the binary isn't installed here, so
// this is a best-effort guess at `codex exec --json` (agent_message_delta) that
// degrades to no-op on unknown shapes rather than crashing. Verify field names
// against real output once codex is on PATH, then tighten.
function mapCodexLine(
  line: string,
  onMeta?: (id: string) => void,
): PiShapedEvent[] {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  const msg = obj?.msg ?? obj;
  if (obj?.session_id) onMeta?.(obj.session_id);
  const t = msg?.type;
  if (t === "agent_message_delta" && typeof msg.delta === "string")
    return [
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: msg.delta },
      },
    ];
  if (t === "error") return [errorEvent(String(msg.message ?? "agent error"))];
  return [];
}

/**
 * Spawn the CLI and yield pi-shaped events. Never throws into the stream: spawn
 * failures (ENOENT) and non-zero exits become a single `message_end` error
 * event that generate.ts renders as an error frame.
 */
export async function* runCliAgent(
  o: CliRunOpts,
): AsyncGenerator<PiShapedEvent> {
  const args =
    o.bin === "claude"
      ? claudeArgs(o)
      : ["exec", "--json", ...(o.model ? ["--model", o.model] : []), o.prompt];
  const mapLine =
    o.bin === "claude"
      ? (l: string) => mapClaudeLine(l, o.workspace, o.onMeta)
      : (l: string) => mapCodexLine(l, o.onMeta);

  const child = spawn(o.bin, args, {
    cwd: o.workspace,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d.toString()));
  const done = new Promise<{
    code: number | null;
    error: NodeJS.ErrnoException | null;
  }>((res) => {
    let settled = false;
    const finish = (v: {
      code: number | null;
      error: NodeJS.ErrnoException | null;
    }) => {
      if (!settled) {
        settled = true;
        res(v);
      }
    };
    child.on("error", (error) => finish({ code: null, error }));
    child.on("close", (code) => finish({ code, error: null }));
  });

  let buf = "";
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) for (const e of mapLine(line)) yield e;
      }
    }
    if (buf.trim()) for (const e of mapLine(buf.trim())) yield e;
  } catch {
    // stdout aborted (process killed) — fall through to exit handling.
  }

  const { code, error } = await done;
  if (error) yield errorEvent(spawnErrMessage(o.bin, error));
  else if (code && code !== 0)
    yield errorEvent(
      `${LABEL[o.bin] ?? o.bin} exited ${code}${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`,
    );
}
