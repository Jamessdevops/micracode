/**
 * In-process entry point. The Electron main process imports this and calls
 * `startCoreServer` — the core runs inside the main process (no spawned child),
 * listening on a localhost port the renderer talks to over HTTP/SSE.
 */

import { serve } from "@hono/node-server";

import { readAuth } from "./auth.js";
import { EventLog } from "./eventlog.js";
import { createApp } from "./server.js";
import { SessionManager } from "./sessions.js";
import { Storage } from "./storage.js";

export interface StartOptions {
  /** Port to bind. `0` (default) picks a free port; read the real one back off the return value. */
  port?: number;
  host?: string;
  /** Overrides `OPENER_APPS_DIR` for this instance. */
  dataRoot?: string;
  /** Provider API keys to inject into the process env before agent sessions start. */
  apiKeys?: Record<string, string>;
  /** Allowed CORS origin(s), comma-separated. Defaults to `*`. */
  webOrigin?: string;
}

export interface CoreServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startCoreServer(opts: StartOptions = {}): Promise<CoreServer> {
  // Persisted keys (the shared auth file) are the source of truth; opts.apiKeys
  // is a legacy fallback (the Electron userData store) applied first so the
  // file wins for any key it defines.
  Object.assign(process.env, opts.apiKeys ?? {}, readAuth());

  const storage = new Storage(opts.dataRoot);
  storage.ensureRoot();
  const log = new EventLog();
  const sessions = new SessionManager(log, storage);
  const app = createApp({ storage, log, sessions, webOrigin: opts.webOrigin });

  const host = opts.host ?? "127.0.0.1";
  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, hostname: host, port: opts.port ?? 0 },
      (info) => {
        resolve({
          port: info.port,
          url: `http://${host}:${info.port}`,
          close: () =>
            new Promise<void>((res, rej) =>
              server.close((err) => (err ? rej(err) : res())),
            ),
        });
      },
    );
  });
}

export { readAuth, writeAuth } from "./auth.js";
export { createApp } from "./server.js";
export { EventLog } from "./eventlog.js";
export { Storage } from "./storage.js";
export { SessionManager } from "./sessions.js";
