import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EventLog } from "../src/eventlog";
import { createApp } from "../src/server";
import { SessionManager } from "../src/sessions";
import { Storage } from "../src/storage";

function app() {
  const storage = new Storage(fs.mkdtempSync(path.join(os.tmpdir(), "mc-tok-")));
  const log = new EventLog();
  return createApp({ storage, log, sessions: new SessionManager(log, storage), token: "s3cret" });
}

describe("/v1 token", () => {
  test("rejects missing, wrong, and simple cross-site requests", async () => {
    const a = app();
    expect((await a.request("/v1/projects")).status).toBe(401);
    expect(
      (await a.request("/v1/projects", { headers: { Authorization: "Bearer nope" } })).status,
    ).toBe(401);
    // A form-style text/plain POST from another site must not get through.
    const res = await a.request("/v1/settings", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ provider: "openai", key: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("accepts the bearer header and the EventSource query form", async () => {
    const a = app();
    const ok = await a.request("/v1/projects", { headers: { Authorization: "Bearer s3cret" } });
    expect(ok.status).toBe(200);
    expect((await a.request("/v1/events?token=s3cret")).status).toBe(200);
  });

  test("sessions refuse an arbitrary workspace path", async () => {
    const a = app();
    const res = await a.request("/v1/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer s3cret", "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "/" }),
    });
    expect(res.status).toBe(400);
  });
});
