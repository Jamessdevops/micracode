/** Default backend origin — matches NEXT_PUBLIC_API_BASE_URL / the Rust bind addr. */
export const DEFAULT_API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

export interface ApiError extends Error {
  status?: number;
  data?: unknown;
}

/**
 * Tiny fetch helper: JSON in/out, throws an `ApiError` carrying `status`/`data`
 * on non-2xx. Ported verbatim from the original single-file client.
 */
export async function api<T = unknown>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const opts: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    (opts.headers as Record<string, string>)["content-type"] =
      "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, opts);
  const txt = await res.text();
  let data: unknown;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = txt;
  }
  if (!res.ok) {
    const detail =
      (data &&
        typeof data === "object" &&
        ((data as Record<string, unknown>).detail ||
          (data as Record<string, unknown>).message)) ||
      `${res.status}`;
    const err = new Error(String(detail)) as ApiError;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data as T;
}

const PERM_LABELS: Record<string, string> = {
  bypassPermissions: "Bypass",
  acceptEdits: "Accept edits",
  plan: "Plan",
  default: "Default",
};

export const DEFAULT_FOLDER = "(default folder)";

export function permLabel(p: string): string {
  return PERM_LABELS[p] ?? p;
}

/** Last path segment for a tidy folder label; the default bucket has no path. */
export function folderLabel(path: string): string {
  if (!path) return DEFAULT_FOLDER;
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function spawnHint(harness: string): string {
  const env = harness === "claude" ? "CLAUDE_BIN" : "CODEX_BIN";
  return `Couldn't start the “${harness}” session. The ${harness} CLI must be installed and on PATH (or set ${env}). Everything else — the engine, event stream and thread projection — is working.`;
}
