import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  collectStaticOutput,
  publicTempPreviewError,
  TempPreviewError,
  TempPreviewService,
} from "../src/temp-preview.js";
import { Storage } from "../src/storage.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("TempPreviewService", () => {
  test("creates, updates, and revokes one stable public preview", async () => {
    const { storage, projectId, projectDir } = fixture();
    writeExport(projectDir, {
      "index.html": "<h1>Hello</h1>",
      "assets/app.css": "body { color: tomato; }",
    });
    fs.writeFileSync(path.join(projectDir, ".env"), "DO_NOT_UPLOAD=secret\n");

    const requests: Array<{ url: string; init?: RequestInit; body?: unknown }> =
      [];
    let publishCount = 0;
    const fakeFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      let body: unknown;
      if (typeof init?.body === "string") body = JSON.parse(init.body);
      requests.push({ url, init, body });

      if (url.endsWith("/publish-sessions") && init?.method === "POST") {
        publishCount += 1;
        const request = body as {
          files: Array<{ path: string }>;
          tempId?: string;
        };
        return Response.json(
          session({
            id: `session-${publishCount}`,
            operation: publishCount === 1 ? "create" : "update",
            tempId: request.tempId ?? "temp-1",
            paths: request.files.map((file) => file.path),
          }),
        );
      }
      if (init?.method === "PUT") return new Response(null, { status: 204 });
      if (url.endsWith("/finalize") && init?.method === "POST") {
        return Response.json({
          success: true,
          tempId: "temp-1",
          versionId: `version-${publishCount}`,
          canonicalUrl: "https://temp.md/example",
          status: "ready",
          expiresAt: "2030-01-08T00:00:00.000Z",
          ...(publishCount === 1 ? { updateToken: "update-secret" } : {}),
        });
      }
      if (url.endsWith("/temps/temp-1") && init?.method === "DELETE") {
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;

    const service = new TempPreviewService(storage, {
      fetch: fakeFetch,
      apiBaseUrl: "https://api.temp.test",
      runBuild: async () => {},
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });

    const created = await service.publish(projectId);
    expect(created.operation).toBe("create");
    expect(created.uploadedFiles).toBe(2);
    expect(created.preview.canonicalUrl).toBe("https://temp.md/example");
    expect(JSON.stringify(created)).not.toContain("secret");

    const statePath = path.join(
      projectDir,
      ".micracode",
      "tempmd-preview.json",
    );
    const state = fs.readFileSync(statePath, "utf8");
    expect(state).toContain("update-secret");
    expect(state).not.toContain("upload-secret");
    if (process.platform !== "win32")
      expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);

    const createRequest = requests.find(
      (request) =>
        request.url.endsWith("/publish-sessions") &&
        !(request.body as { tempId?: string } | undefined)?.tempId,
    );
    expect(createRequest?.body).toEqual({
      files: [
        expect.objectContaining({ path: "assets/app.css" }),
        expect.objectContaining({ path: "index.html" }),
      ],
      spaMode: false,
    });
    expect(JSON.stringify(createRequest?.body)).not.toContain("projectId");
    expect(JSON.stringify(createRequest?.body)).not.toContain("DO_NOT_UPLOAD");

    writeExport(projectDir, { "index.html": "<h1>Updated</h1>" });
    const updated = await service.publish(projectId);
    expect(updated.operation).toBe("update");
    expect(updated.preview.canonicalUrl).toBe(created.preview.canonicalUrl);
    const updateRequest = requests.filter((request) =>
      request.url.endsWith("/publish-sessions"),
    )[1];
    expect((updateRequest.body as { tempId: string }).tempId).toBe("temp-1");
    expect(new Headers(updateRequest.init?.headers).get("Authorization")).toBe(
      "Bearer update-secret",
    );

    expect((await service.revoke(projectId)).preview).toEqual({
      hasPreview: false,
    });
    expect(fs.existsSync(statePath)).toBe(false);
  });

  test("preserves the last successful preview when a later build fails", async () => {
    const { storage, projectId, projectDir } = fixture();
    writeExport(projectDir, { "index.html": "ready" });
    const service = new TempPreviewService(storage, {
      fetch: successfulFetch(),
      apiBaseUrl: "https://api.temp.test",
      runBuild: async () => {},
    });
    const published = await service.publish(projectId);

    let fetched = false;
    const failing = new TempPreviewService(storage, {
      fetch: (async () => {
        fetched = true;
        throw new Error("should not fetch");
      }) as typeof fetch,
      apiBaseUrl: "https://api.temp.test",
      runBuild: async () => {
        throw new TempPreviewError(
          "The static build failed.",
          422,
          "static_build_failed",
        );
      },
    });
    await expect(failing.publish(projectId)).rejects.toMatchObject({
      code: "static_build_failed",
    });
    expect(fetched).toBe(false);
    expect(failing.status(projectId)).toEqual(published.preview);
  });

  test("resumes a matching pending session after an interrupted upload", async () => {
    const { storage, projectId, projectDir } = fixture();
    writeExport(projectDir, { "index.html": "resume me" });
    let createCalls = 0;
    let putCalls = 0;
    let statusCalls = 0;
    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith("/publish-sessions") && init?.method === "POST") {
        createCalls += 1;
        return Response.json(
          session({ id: "session-resume", paths: ["index.html"] }),
        );
      }
      if (url.endsWith("/publish-sessions/session-resume") && !init?.method) {
        statusCalls += 1;
        return Response.json(
          session({ id: "session-resume", paths: ["index.html"] }),
        );
      }
      if (init?.method === "PUT") {
        putCalls += 1;
        return putCalls === 1
          ? Response.json({ message: "Try again." }, { status: 503 })
          : new Response(null, { status: 204 });
      }
      if (url.endsWith("/finalize") && init?.method === "POST") {
        return Response.json({
          success: true,
          tempId: "temp-1",
          versionId: "version-1",
          canonicalUrl: "https://temp.md/resumed",
          status: "ready",
          expiresAt: null,
          updateToken: "update-secret",
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;
    const service = new TempPreviewService(storage, {
      fetch: fetcher,
      apiBaseUrl: "https://api.temp.test",
      runBuild: async () => {},
    });

    await expect(service.publish(projectId)).rejects.toMatchObject({
      status: 503,
    });
    expect(await service.publish(projectId)).toMatchObject({
      operation: "create",
      preview: { canonicalUrl: "https://temp.md/resumed" },
    });
    expect(createCalls).toBe(1);
    expect(statusCalls).toBe(1);
    expect(putCalls).toBe(2);
  });
});

describe("static output boundary", () => {
  test("rejects symbolic links and requires a root index", () => {
    const root = temporaryRoot();
    const out = path.join(root, "out");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(root, "private.txt"), "private");
    fs.writeFileSync(path.join(out, "index.html"), "safe");
    fs.symlinkSync(
      path.join(root, "private.txt"),
      path.join(out, "private.txt"),
    );

    expect(() => collectStaticOutput(out)).toThrow("symbolic link");
    fs.unlinkSync(path.join(out, "private.txt"));
    fs.unlinkSync(path.join(out, "index.html"));
    expect(() => collectStaticOutput(out)).toThrow("index.html");
  });

  test("does not expose messages that may contain capabilities", () => {
    const response = publicTempPreviewError(
      new TempPreviewError("Bearer upload-secret leaked", 502, "token_leaked"),
    );
    expect(response.body).toEqual({
      detail: "Temporary preview failed.",
      code: "internal_error",
    });
  });
});

function fixture(): {
  storage: Storage;
  projectId: string;
  projectDir: string;
} {
  const root = temporaryRoot();
  const storage = new Storage(root);
  const projectId = storage.createProject("Preview Test", "empty").id;
  return { storage, projectId, projectDir: storage.projectDir(projectId) };
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "micracode-temp-preview-"),
  );
  roots.push(root);
  return root;
}

function writeExport(projectDir: string, files: Record<string, string>): void {
  const output = path.join(projectDir, "out");
  fs.rmSync(output, { recursive: true, force: true });
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(output, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

function session({
  id,
  operation = "create",
  tempId = "temp-1",
  paths,
}: {
  id: string;
  operation?: "create" | "update";
  tempId?: string;
  paths: string[];
}) {
  return {
    sessionId: id,
    tempId,
    operation,
    status: "pending",
    uploadToken: "upload-secret",
    uploads: paths.map((filePath, index) => ({
      path: filePath,
      status: "expected",
      url: `https://api.temp.test/publish-sessions/${id}/files/file-${index}`,
    })),
    skipped: [],
    expiresAt: "2030-01-01T00:10:00.000Z",
  };
}

function successfulFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/publish-sessions") && init?.method === "POST") {
      return Response.json(session({ id: "session-1", paths: ["index.html"] }));
    }
    if (init?.method === "PUT") return new Response(null, { status: 204 });
    if (url.endsWith("/finalize") && init?.method === "POST") {
      return Response.json({
        success: true,
        tempId: "temp-1",
        versionId: "version-1",
        canonicalUrl: "https://temp.md/example",
        status: "ready",
        expiresAt: null,
        updateToken: "update-secret",
      });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
}
