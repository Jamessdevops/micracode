/**
 * The `/v1` HTTP surface, built on Hono. Vertical slice of the event-sourced
 * contract the web client speaks (see apps/web/src/lib/api/*):
 *
 *   implemented: health, models, projects (CRUD + files + prompts),
 *                sessions (start/turn/interrupt/resume/stop), events(+stream)
 *   stubbed:     threads, vcs + checkpoints, commands, snapshots, download
 *
 * Stubs return 501 so the missing pieces are loud, not silently wrong.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";

import { writeAuth } from "./auth.js";
import { EventLog } from "./eventlog.js";
import { Generator } from "./generate.js";
import { SessionManager, type StartSessionBody } from "./sessions.js";
import { Storage } from "./storage.js";
import { publicTempPreviewError, TempPreviewService } from "./temp-preview.js";

export interface CoreDeps {
  storage: Storage;
  log: EventLog;
  sessions: SessionManager;
  webOrigin?: string;
  tempPreviews?: TempPreviewService;
}

const NOT_IMPLEMENTED = (what: string) => ({ detail: `${what} not implemented yet` });

export function createApp(deps: CoreDeps): Hono {
  const { storage, log, sessions } = deps;
  const generator = new Generator(storage);
  const tempPreviews = deps.tempPreviews ?? new TempPreviewService(storage);
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: deps.webOrigin?.split(",").map((o) => o.trim()) ?? "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Accept"],
    }),
  );

  const v1 = new Hono();

  // --- health ---------------------------------------------------------------
  v1.get("/health", (c) =>
    c.json({ status: "ok", environment: "desktop", provider: "pi", model: "pi-default" }),
  );

  // --- models ---------------------------------------------------------------
  // minimal catalog inherited from the old contract; the sessions
  // model takes a free-form `model` string, so this is mostly legacy.
  v1.get("/models", (c) =>
    c.json({
      providers: [
        {
          id: "openai",
          label: "OpenAI",
          available: Boolean(process.env.OPENAI_API_KEY),
          models: [{ id: "gpt-5", label: "GPT-5" }],
        },
        {
          id: "gemini",
          label: "Gemini",
          available: Boolean(process.env.GOOGLE_API_KEY),
          models: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }],
        },
      ],
      default: { provider: "openai", model: "gpt-5" },
    }),
  );

  // --- settings -------------------------------------------------------------
  // Read/persist user API keys in the shared dedicated auth file. OpenAI only
  // for now, matching the web client's SettingsView shape.
  const mask = (k: string) => (k ? (k.length > 4 ? `…${k.slice(-4)}` : "…") : null);
  const settingsView = () => {
    const key = process.env.OPENAI_API_KEY ?? "";
    return { openai: { configured: Boolean(key), hint: mask(key) } };
  };

  v1.get("/settings", (c) => c.json(settingsView()));

  v1.post("/settings", async (c) => {
    const body = await c.req.json<{ openai_api_key?: string }>();
    const key = (body?.openai_api_key ?? "").trim();
    writeAuth("OPENAI_API_KEY", key); // persist to the shared file
    process.env.OPENAI_API_KEY = key; // live effect for the running core
    return c.json(settingsView());
  });

  // --- projects -------------------------------------------------------------
  v1.get("/projects", (c) => c.json(storage.listProjects()));

  v1.post("/projects", async (c) => {
    const body = await c.req.json<{ name: string; template?: string }>();
    if (!body?.name) return c.json({ detail: "name is required" }, 400);
    return c.json(storage.createProject(body.name, body.template), 201);
  });

  v1.get("/projects/:id", (c) => {
    const id = c.req.param("id");
    const rec = storage.getProject(id);
    if (!rec) return c.json({ detail: "project not found" }, 404);
    return c.json({ ...rec, root_path: storage.projectDir(id) });
  });

  v1.delete("/projects/:id", (c) =>
    storage.deleteProject(c.req.param("id"))
      ? c.body(null, 204)
      : c.json({ detail: "project not found" }, 404),
  );

  v1.get("/projects/:id/files", (c) => {
    const id = c.req.param("id");
    if (!storage.getProject(id)) return c.json({ detail: "project not found" }, 404);
    return c.json({ tree: storage.readTree(id) });
  });

  v1.put("/projects/:id/files", async (c) => {
    const id = c.req.param("id");
    if (!storage.getProject(id)) return c.json({ detail: "project not found" }, 404);
    const body = await c.req.json<{ path: string; content: string }>();
    if (!body?.path) return c.json({ detail: "path is empty" }, 400);
    try {
      storage.writeFile(id, body.path, body.content ?? "");
    } catch (err) {
      return c.json({ detail: String(err) }, 400);
    }
    return c.body(null, 204);
  });

  v1.get("/projects/:id/prompts", (c) => {
    const id = c.req.param("id");
    if (!storage.getProject(id)) return c.json({ detail: "project not found" }, 404);
    return c.json(storage.readPrompts(id));
  });

  // Static, public previews are opt-in. The service builds and verifies only
  // the project's `out/` directory; capability tokens never reach the client.
  v1.get("/projects/:id/temp-preview", (c) => {
    c.header("Cache-Control", "no-store");
    try {
      return c.json(tempPreviews.status(c.req.param("id")));
    } catch (error) {
      return tempPreviewErrorResponse(error);
    }
  });

  v1.post("/projects/:id/temp-preview", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await tempPreviews.publish(c.req.param("id")));
    } catch (error) {
      return tempPreviewErrorResponse(error);
    }
  });

  v1.delete("/projects/:id/temp-preview", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await tempPreviews.revoke(c.req.param("id")));
    } catch (error) {
      return tempPreviewErrorResponse(error);
    }
  });

  // Stubs — projects surface the web client also calls.
  v1.get("/projects/:id/snapshots", (c) => c.json([]));
  v1.get("/projects/:id/download", (c) => c.json(NOT_IMPLEMENTED("project download"), 501));
  v1.get("/projects/:id/vcs/status", (c) => c.json(NOT_IMPLEMENTED("vcs"), 501));
  v1.get("/projects/:id/checkpoints", (c) => c.json(NOT_IMPLEMENTED("checkpoints"), 501));

  // --- generate -------------------------------------------------------------
  // The code-generation stream the web chat panels POST to (AI SDK UI Message
  // Stream Protocol). Bridges a pi coding-agent run to the client's frames.
  v1.post("/generate", (c) => generator.handle(c));

  // --- sessions -------------------------------------------------------------
  v1.post("/sessions", async (c) => {
    const body = await c.req.json<StartSessionBody>();
    try {
      return c.json(await sessions.start(body));
    } catch (err) {
      return c.json({ detail: String(err) }, 400);
    }
  });

  v1.post("/sessions/:id/turn", async (c) => {
    const body = await c.req.json<{ text: string }>();
    return c.json({ accepted: sessions.turn(c.req.param("id"), body?.text ?? "") });
  });

  v1.post("/sessions/:id/interrupt", (c) =>
    c.json({ accepted: sessions.interrupt(c.req.param("id")) }),
  );

  v1.post("/sessions/:id/resume", (c) => {
    const info = sessions.info(c.req.param("id"));
    return info ? c.json(info) : c.json({ detail: "session not found" }, 404);
  });

  v1.delete("/sessions/:id", (c) => c.json({ stopped: sessions.stop(c.req.param("id")) }));

  // --- events ---------------------------------------------------------------
  v1.get("/events", (c) => {
    const cursor = Number(c.req.query("cursor") ?? "0") || 0;
    return c.json(log.since(cursor));
  });

  v1.get("/events/stream", (c) => {
    const cursor = Number(c.req.query("cursor") ?? "0") || 0;
    return streamSSE(c, async (stream) => {
      // Replay the backlog, then follow live events until the client leaves.
      for (const event of log.since(cursor).events) {
        await stream.writeSSE({ data: JSON.stringify(event) });
      }
      let done: () => void = () => {};
      const closed = new Promise<void>((resolve) => (done = resolve));
      const unsub = log.subscribe((event) => {
        void stream.writeSSE({ data: JSON.stringify(event) });
      });
      stream.onAbort(() => {
        unsub();
        done();
      });
      await closed;
    });
  });

  // --- threads (stub) -------------------------------------------------------
  v1.get("/threads", (c) => c.json([]));
  v1.get("/threads/:id", (c) => c.json(NOT_IMPLEMENTED("thread projection"), 501));
  v1.post("/commands", (c) => c.json(NOT_IMPLEMENTED("command bus"), 501));

  app.route("/v1", v1);
  return app;
}

function tempPreviewErrorResponse(error: unknown): Response {
  const response = publicTempPreviewError(error);
  return Response.json(response.body, {
    status: response.status,
    headers: { "Cache-Control": "no-store" },
  });
}
