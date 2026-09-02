import {
  ApiError,
  BundleValidationError,
  manifestHash,
  PREVIEW_STATE_SCHEMA_URL,
  PREVIEW_STATE_VERSION,
  TempmdClient,
  TempmdPreviewClient,
  validateBundle,
  type PreviewFile,
  type PreviewIntegrationState,
  type PreviewRecord,
} from "@tempmd/client";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";

import { Storage } from "./storage.js";

const DEFAULT_API_BASE_URL = "https://api.temp.md";
const CLIENT_IDENTITY = "micracode/0.1.0";
const MAX_FILES = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 3 * 60 * 1000;

type StoredPreviewState = PreviewIntegrationState & { projectId: string };

export type PreparedStaticFile = {
  path: string;
  size: number;
  contentType: string;
  hash: string;
  body: Buffer;
};

export type PublicTempPreview = {
  hasPreview: boolean;
  canonicalUrl?: string;
  expiresAt?: string | null;
  updatedAt?: string;
};

export type PublishTempPreviewResult = {
  operation: "create" | "update";
  uploadedFiles: number;
  preview: PublicTempPreview;
};

export type TempPreviewDependencies = {
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  runBuild?: (projectDir: string) => Promise<void>;
  createId?: () => string;
};

export class TempPreviewError extends Error {
  readonly name = "TempPreviewError";

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export class TempPreviewService {
  private readonly activeProjects = new Set<string>();

  constructor(
    private readonly storage: Storage,
    private readonly dependencies: TempPreviewDependencies = {},
  ) {}

  status(projectId: string): PublicTempPreview {
    this.requireProject(projectId);
    return toPublicPreview(readState(this.statePath(projectId), projectId)?.current);
  }

  async publish(projectId: string): Promise<PublishTempPreviewResult> {
    return this.withProjectLock(projectId, async () => {
      try {
        this.requireProject(projectId);
        const projectDir = this.storage.projectDir(projectId);
        await (this.dependencies.runBuild ?? runStaticBuild)(projectDir);
        const prepared = collectStaticOutput(path.join(projectDir, "out"));
        const files: PreviewFile[] = prepared.map((file) => ({
          path: file.path,
          data: file.body,
          contentType: file.contentType,
        }));
        const stateFile = this.statePath(projectId);
        const saved = readState(stateFile, projectId);
        const client = this.previewClient();
        const onState = (state: PreviewIntegrationState) =>
          writeState(stateFile, { ...state, projectId }, this.dependencies);
        const options = {
          files,
          spaMode: false,
          requireIndex: true,
          onState,
        };

        let operation: "create" | "update";
        let result;
        if (saved?.pending && (await pendingMatches(saved, files))) {
          operation = saved.pending.operation;
          result = await client.resumePreview(saved, options);
        } else if (saved?.current) {
          operation = "update";
          result = await client.updatePreview(saved.current, options);
        } else {
          operation = "create";
          result = await client.publishPreview(options);
        }

        return {
          operation,
          uploadedFiles: result.uploaded,
          preview: toPublicPreview(result.record),
        };
      } catch (error) {
        throw normalizeError(error);
      }
    });
  }

  async revoke(projectId: string): Promise<{ ok: true; preview: PublicTempPreview }> {
    return this.withProjectLock(projectId, async () => {
      try {
        this.requireProject(projectId);
        const stateFile = this.statePath(projectId);
        const state = readState(stateFile, projectId);
        if (!state?.current) {
          throw new TempPreviewError(
            "This project does not have a temporary preview.",
            404,
            "preview_not_found",
          );
        }
        await this.previewClient().revokePreview(state.current);
        try {
          fs.unlinkSync(stateFile);
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
        return { ok: true, preview: { hasPreview: false } };
      } catch (error) {
        throw normalizeError(error);
      }
    });
  }

  private previewClient(): TempmdPreviewClient {
    const baseUrl = apiBaseUrl(this.dependencies);
    return new TempmdPreviewClient(
      new TempmdClient({
        baseUrl,
        fetch: sameOriginFetch(baseUrl, this.dependencies.fetch ?? fetch),
        clientIdentity: CLIENT_IDENTITY,
      }),
    );
  }

  private statePath(projectId: string): string {
    return path.join(this.storage.projectDir(projectId), ".micracode", "tempmd-preview.json");
  }

  private requireProject(projectId: string) {
    const project = this.storage.getProject(projectId);
    if (!project) {
      throw new TempPreviewError("Project not found.", 404, "project_not_found");
    }
    return project;
  }

  private async withProjectLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    if (this.activeProjects.has(projectId)) {
      throw new TempPreviewError(
        "A temporary preview operation is already running for this project.",
        409,
        "preview_busy",
      );
    }
    this.activeProjects.add(projectId);
    try {
      return await work();
    } finally {
      this.activeProjects.delete(projectId);
    }
  }
}

export function collectStaticOutput(outputDir: string): PreparedStaticFile[] {
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(outputDir);
  } catch (error) {
    if (isEnoent(error)) {
      throw new TempPreviewError(
        "The static build did not produce an out directory.",
        422,
        "static_output_missing",
      );
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new TempPreviewError(
      "The static output directory is not a real directory.",
      422,
      "unsafe_static_output",
    );
  }

  const rootReal = fs.realpathSync(outputDir);
  const files: PreparedStaticFile[] = [];
  let totalBytes = 0;

  const walk = (directory: string, prefix: string): void => {
    assertInsideRoot(fs.realpathSync(directory), rootReal);
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      validateEntryName(entry.name);
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new TempPreviewError(
          `Static output contains a symbolic link: ${relative}`,
          422,
          "unsafe_static_output",
        );
      }
      if (stat.isDirectory()) {
        assertInsideRoot(fs.realpathSync(absolute), rootReal);
        walk(absolute, relative);
        continue;
      }
      if (!stat.isFile()) {
        throw new TempPreviewError(
          `Static output contains an unsupported entry: ${relative}`,
          422,
          "unsafe_static_output",
        );
      }
      assertInsideRoot(fs.realpathSync(absolute), rootReal);
      if (files.length >= MAX_FILES) {
        throw new TempPreviewError(
          `Static previews are limited to ${MAX_FILES} files.`,
          413,
          "too_many_files",
        );
      }
      if (stat.size > MAX_FILE_BYTES) {
        throw new TempPreviewError(
          `Static preview files are limited to ${formatMegabytes(MAX_FILE_BYTES)} each.`,
          413,
          "file_too_large",
        );
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new TempPreviewError(
          `Static previews are limited to ${formatMegabytes(MAX_TOTAL_BYTES)} total.`,
          413,
          "preview_too_large",
        );
      }

      const descriptor = fs.openSync(
        absolute,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      let body: Buffer;
      try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.size !== stat.size) {
          throw new TempPreviewError(
            `Static output changed while reading: ${relative}`,
            409,
            "static_output_changed",
          );
        }
        body = fs.readFileSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      files.push({
        path: relative,
        size: body.byteLength,
        contentType: contentTypeFor(relative),
        hash: createHash("sha256").update(body).digest("hex"),
        body,
      });
    }
  };

  walk(outputDir, "");
  if (files.length === 0 || !files.some((file) => file.path === "index.html")) {
    throw new TempPreviewError(
      "The static export must contain index.html.",
      422,
      "missing_index",
    );
  }
  return files;
}

export async function runStaticBuild(projectDir: string): Promise<void> {
  const packageFile = path.join(projectDir, "package.json");
  let packageJson: { scripts?: Record<string, unknown> };
  try {
    packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
  } catch {
    throw new TempPreviewError(
      "Temporary preview requires a valid package.json.",
      422,
      "invalid_package_json",
    );
  }
  const build = packageJson.scripts?.build;
  if (typeof build !== "string" || !build.trim()) {
    throw new TempPreviewError(
      'Temporary preview requires a non-empty "scripts.build" command.',
      422,
      "build_script_missing",
    );
  }

  await new Promise<void>((resolve, reject) => {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(command, ["run", "build"], {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, BUILD_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(
        new TempPreviewError(
          "The static build could not be started.",
          422,
          "static_build_failed",
        ),
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) return resolve();
      reject(
        new TempPreviewError(
          timedOut
            ? "The static build exceeded three minutes."
            : "The static build failed. Run npm run build in the project for details.",
          timedOut ? 504 : 422,
          timedOut ? "static_build_timeout" : "static_build_failed",
        ),
      );
    });
  });
}

export function publicTempPreviewError(error: unknown): {
  status: number;
  body: { detail: string; code: string; requestId?: string; retryAfter?: number };
} {
  const normalized = normalizeError(error);
  return {
    status: normalized.status,
    body: {
      detail: safeMessage(normalized.message, "Temporary preview failed."),
      code: safeCode(normalized.code),
      ...(safeRequestId(normalized.requestId)
        ? { requestId: normalized.requestId }
        : {}),
      ...(normalized.retryAfter !== undefined
        ? { retryAfter: normalized.retryAfter }
        : {}),
    },
  };
}

async function pendingMatches(
  state: StoredPreviewState,
  files: PreviewFile[],
): Promise<boolean> {
  if (!state.pending) return false;
  const validation = await validateBundle(files, { requireIndex: true });
  if (!validation.valid) throw new BundleValidationError(validation.issues);
  return (
    (await manifestHash(validation.files, { spaMode: false })) ===
    state.pending.manifestHash
  );
}

function readState(
  stateFile: string,
  projectId: string,
): StoredPreviewState | null {
  try {
    const stat = fs.lstatSync(stateFile);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new TempPreviewError(
        "The saved temporary preview state is not a regular file.",
        500,
        "unsafe_saved_state",
      );
    }
    const value = JSON.parse(fs.readFileSync(stateFile, "utf8")) as unknown;
    if (!isStoredState(value, projectId)) {
      throw new TempPreviewError(
        "The saved temporary preview state is invalid.",
        500,
        "invalid_saved_state",
      );
    }
    return value;
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof TempPreviewError) throw error;
    throw new TempPreviewError(
      "The saved temporary preview state could not be read.",
      500,
      "state_read_failed",
    );
  }
}

function writeState(
  stateFile: string,
  state: StoredPreviewState,
  dependencies: TempPreviewDependencies,
): void {
  const directory = path.dirname(stateFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new TempPreviewError(
      "The Micracode sidecar is not a regular directory.",
      500,
      "unsafe_state_directory",
    );
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Windows does not implement POSIX modes; atomic replacement still applies.
  }

  const temporary = `${stateFile}.${process.pid}.${dependencies.createId?.() ?? randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, stateFile);
    try {
      fs.chmodSync(stateFile, 0o600);
    } catch {
      // Windows does not implement POSIX modes.
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best-effort cleanup after a failed atomic write.
    }
    throw error;
  }
}

function isStoredState(value: unknown, projectId: string): value is StoredPreviewState {
  return (
    isRecord(value) &&
    value.$schema === PREVIEW_STATE_SCHEMA_URL &&
    value.schemaVersion === PREVIEW_STATE_VERSION &&
    value.projectId === projectId &&
    (value.current === undefined || isPreviewRecord(value.current)) &&
    (value.pending === undefined || isPendingState(value.pending))
  );
}

function isPreviewRecord(value: unknown): value is PreviewRecord {
  return (
    isRecord(value) &&
    value.schemaVersion === PREVIEW_STATE_VERSION &&
    typeof value.tempId === "string" &&
    isHttpsUrl(value.canonicalUrl) &&
    typeof value.updateToken === "string" &&
    value.updateToken.length > 0 &&
    (typeof value.expiresAt === "string" || value.expiresAt === null) &&
    typeof value.spaMode === "boolean" &&
    typeof value.updatedAt === "string"
  );
}

function isPendingState(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.uploadToken === "string" &&
    typeof value.idempotencyKey === "string" &&
    (value.operation === "create" || value.operation === "update") &&
    typeof value.manifestHash === "string" &&
    typeof value.tempId === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.spaMode === "boolean"
  );
}

function toPublicPreview(current?: PreviewRecord): PublicTempPreview {
  if (!current) return { hasPreview: false };
  return {
    hasPreview: true,
    canonicalUrl: current.canonicalUrl,
    expiresAt: current.expiresAt,
    updatedAt: current.updatedAt,
  };
}

function apiBaseUrl(dependencies: TempPreviewDependencies): string {
  const value = (
    dependencies.apiBaseUrl ??
    process.env.TEMPMD_API_URL ??
    DEFAULT_API_BASE_URL
  ).replace(/\/+$/, "");
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.toString().replace(/\/+$/, "");
  } catch {
    // Fall through to the safe configuration error below.
  }
  throw new TempPreviewError(
    "The temp.md API URL must use HTTPS.",
    500,
    "unsafe_api_url",
  );
}

function sameOriginFetch(baseUrl: string, fetcher: typeof fetch): typeof fetch {
  const base = new URL(baseUrl);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(
      input instanceof Request ? input.url : String(input),
      base,
    );
    if (target.protocol !== "https:" || target.origin !== base.origin) {
      throw new TempPreviewError(
        "temp.md returned an unsafe request target.",
        502,
        "unsafe_request_target",
      );
    }
    return fetcher(input, init);
  }) as typeof fetch;
}

function normalizeError(error: unknown): TempPreviewError {
  if (error instanceof TempPreviewError) return error;
  if (error instanceof ApiError) {
    return new TempPreviewError(
      safeMessage(error.message, "The temp.md request failed."),
      error.status >= 400 && error.status <= 599 ? error.status : 502,
      safeCode(error.code, "request_failed"),
      safeRequestId(error.requestId),
      error.retryAfter,
    );
  }
  if (error instanceof BundleValidationError) {
    const tooLarge = error.issues.some((issue) =>
      ["too_many_files", "file_too_large", "bundle_too_large"].includes(
        issue.code,
      ),
    );
    return new TempPreviewError(
      safeMessage(error.message, "The static export is not valid."),
      tooLarge ? 413 : 422,
      "invalid_static_export",
    );
  }
  return new TempPreviewError(
    "Temporary preview failed.",
    500,
    "internal_error",
  );
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".xml": "application/xml; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".otf": "font/otf",
      ".pdf": "application/pdf",
      ".wasm": "application/wasm",
    }[extension] ?? "application/octet-stream"
  );
}

function validateEntryName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[\\/\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new TempPreviewError(
      "Static output contains an unsafe path.",
      422,
      "unsafe_static_output",
    );
  }
}

function assertInsideRoot(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TempPreviewError(
      "Static output escapes the export directory.",
      422,
      "unsafe_static_output",
    );
  }
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function safeMessage(candidate: string | undefined, fallback: string): string {
  if (
    !candidate ||
    candidate.length > 300 ||
    /token|authorization|credential|secret|bearer/i.test(candidate)
  ) {
    return fallback;
  }
  return candidate;
}

function safeCode(candidate: string | undefined, fallback = "internal_error"): string {
  if (
    !candidate ||
    !/^[a-z0-9_]{1,80}$/i.test(candidate) ||
    /token|authorization|credential|secret|bearer/i.test(candidate)
  ) {
    return fallback;
  }
  return candidate;
}

function safeRequestId(candidate: string | undefined): string | undefined {
  return candidate &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(candidate) &&
    !/token|authorization|credential|secret|bearer/i.test(candidate)
    ? candidate
    : undefined;
}

function formatMegabytes(bytes: number): string {
  return `${bytes / 1024 / 1024} MiB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
