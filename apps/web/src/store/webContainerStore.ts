"use client";

import type { FileSystemTree } from "@micracode/shared";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { create } from "zustand";

import { isDesktop } from "@/lib/desktop";
import { flattenFileSystemTree, useFileSystemStore } from "@/store/fileSystemStore";

export type WebContainerPhase =
  | "idle"
  | "booting"
  | "mounting"
  | "installing"
  | "startingDev"
  | "ready"
  | "error";

export interface ShellExecRequest {
  command: string;
  cwd?: string;
}

export type OutputSource = "install" | "dev" | "shell";

export interface OutputLine {
  id: number;
  source: OutputSource;
  text: string;
  isError: boolean;
  at: number;
}

const OUTPUT_BUFFER_CAP = 200;

// Heuristic patterns that flag an output line as "error-like" so the
// "Fix with AI" button knows when to light up. Kept intentionally loose
// — false positives are cheaper than false negatives for this UX.
const ERROR_PATTERNS: RegExp[] = [
  /\berror\b/i,
  /\bERR_/i,
  /\bEADDRINUSE\b/,
  /\bENOENT\b/,
  /\bECONN(?:REFUSED|RESET)\b/,
  /error TS\d+:/,
  /Module not found/i,
  /Cannot find module/i,
  /UnhandledPromiseRejection/i,
  /SyntaxError/,
  /TypeError/,
  /ReferenceError/,
  /Failed to compile/i,
];

function looksLikeError(line: string): boolean {
  if (!line.trim()) return false;
  return ERROR_PATTERNS.some((re) => re.test(line));
}

interface WebContainerState {
  phase: WebContainerPhase;
  previewUrl: string | null;
  errorMessage: string | null;
  shellQueue: ShellExecRequest[];
  output: OutputLine[];
}

interface WebContainerActions {
  startPreview: (projectId?: string) => Promise<void>;
  stopPreview: (projectId?: string) => void;
  enqueueShell: (command: string, cwd?: string) => void;
  clearOutput: () => void;
  getRecentErrors: (limit?: number) => OutputLine[];
}

// --- module refs (WebContainer is not serializable) ---------------------------------

let wc: WebContainer | null = null;
let devProc: WebContainerProcess | null = null;
let offServerReady: (() => void) | null = null;
let offFsSync: (() => void) | null = null;
let treeSnapshot: FileSystemTree = {};
let startLock = false;
let outputSeq = 0;
let lineCarry = "";

function appendOutput(source: OutputSource, chunk: string): void {
  // Stream chunks are not guaranteed to end on a newline; buffer the
  // trailing partial line until the next chunk (or process exit)
  // completes it. Otherwise a single logical error line would be split
  // across multiple OutputLine entries.
  const combined = lineCarry + chunk;
  const lines = combined.split(/\r?\n/);
  lineCarry = lines.pop() ?? "";
  if (lines.length === 0) return;
  const now = Date.now();
  const additions: OutputLine[] = [];
  for (const raw of lines) {
    const text = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    if (!text) continue;
    additions.push({
      id: ++outputSeq,
      source,
      text,
      isError: looksLikeError(text),
      at: now,
    });
  }
  if (additions.length === 0) return;
  useWebContainerStore.setState((state) => {
    const merged = [...state.output, ...additions];
    const overflow = merged.length - OUTPUT_BUFFER_CAP;
    return { output: overflow > 0 ? merged.slice(overflow) : merged };
  });
}

function flushOutputCarry(source: OutputSource): void {
  if (!lineCarry) return;
  const text = lineCarry.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  lineCarry = "";
  if (!text) return;
  const line: OutputLine = {
    id: ++outputSeq,
    source,
    text,
    isError: looksLikeError(text),
    at: Date.now(),
  };
  useWebContainerStore.setState((state) => {
    const merged = [...state.output, line];
    const overflow = merged.length - OUTPUT_BUFFER_CAP;
    return { output: overflow > 0 ? merged.slice(overflow) : merged };
  });
}

function cloneTree(tree: FileSystemTree): FileSystemTree {
  return JSON.parse(JSON.stringify(tree)) as FileSystemTree;
}

async function ensureParentDirs(instance: WebContainer, filePath: string): Promise<void> {
  const normalized = filePath.replace(/^\/+/, "");
  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.length <= 1) return;
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments.slice(0, i + 1).join("/");
    try {
      await instance.fs.mkdir(dir, { recursive: true });
    } catch {
      // directory may already exist
    }
  }
}

async function writeFileDeep(instance: WebContainer, path: string, content: string): Promise<void> {
  await ensureParentDirs(instance, path);
  await instance.fs.writeFile(path, content);
}

async function rmDeep(instance: WebContainer, path: string): Promise<void> {
  try {
    await instance.fs.rm(path, { force: true, recursive: true });
  } catch {
    // ignore missing paths
  }
}

async function applyTreeDiff(
  instance: WebContainer,
  before: FileSystemTree,
  after: FileSystemTree,
): Promise<{ packageDepsChanged: boolean }> {
  const prev = new Map(
    flattenFileSystemTree(before).map((f) => [f.path, f.content] as const),
  );
  const next = new Map(
    flattenFileSystemTree(after).map((f) => [f.path, f.content] as const),
  );
  for (const path of prev.keys()) {
    if (!next.has(path)) await rmDeep(instance, path);
  }
  for (const [path, content] of next) {
    if (prev.get(path) !== content) await writeFileDeep(instance, path, content);
  }
  const packageDepsChanged = didPackageDepsChange(
    prev.get("package.json"),
    next.get("package.json"),
  );
  return { packageDepsChanged };
}

/** Parse ``package.json`` dependency sections into a canonical JSON string. */
function extractDepsSignature(pkgContent: string | undefined): string {
  if (!pkgContent) return "";
  try {
    const parsed = JSON.parse(pkgContent) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const pick = (obj: Record<string, string> | undefined): Record<string, string> => {
      if (!obj) return {};
      return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
    };
    return JSON.stringify({
      dependencies: pick(parsed.dependencies),
      devDependencies: pick(parsed.devDependencies),
      peerDependencies: pick(parsed.peerDependencies),
      optionalDependencies: pick(parsed.optionalDependencies),
    });
  } catch {
    return pkgContent;
  }
}

function didPackageDepsChange(
  before: string | undefined,
  after: string | undefined,
): boolean {
  return extractDepsSignature(before) !== extractDepsSignature(after);
}

function readDevScript(tree: FileSystemTree): string | null {
  const flat = flattenFileSystemTree(tree);
  const pkg = flat.find((f) => f.path === "package.json");
  if (!pkg) return null;
  try {
    const parsed = JSON.parse(pkg.content) as { scripts?: Record<string, string> };
    const dev = parsed.scripts?.dev;
    return typeof dev === "string" && dev.trim().length > 0 ? dev.trim() : null;
  } catch {
    return null;
  }
}

async function drainOutput(
  stream: ReadableStream<string>,
  source: OutputSource,
): Promise<void> {
  // WebContainer rejects in-flight reads with "Process aborted" when the
  // owning process is killed (e.g. via teardown). Treat any error as a
  // benign end-of-stream so it doesn't surface as an unhandled rejection.
  let reader: ReadableStreamDefaultReader<string>;
  try {
    reader = stream.getReader();
  } catch {
    return;
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (typeof value === "string" && value.length > 0) {
        appendOutput(source, value);
      }
    }
    flushOutputCarry(source);
  } catch {
    // swallow: the process was killed or the stream was cancelled
    flushOutputCarry(source);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

async function safeExit(proc: WebContainerProcess): Promise<number> {
  // `proc.exit` rejects with "Process aborted" if the WebContainer is torn
  // down or the process is killed mid-flight. Coerce that to a sentinel
  // negative exit code so callers never see an unhandled rejection.
  try {
    return await proc.exit;
  } catch {
    return -1;
  }
}

async function runShell(
  instance: WebContainer,
  command: string,
  cwd?: string,
): Promise<number> {
  const proc = await instance.spawn("sh", ["-c", command], {
    cwd: cwd && cwd.length > 0 ? cwd : undefined,
    output: true,
  });
  void drainOutput(proc.output, "shell");
  return safeExit(proc);
}

function flushShellQueue(): void {
  const pending = useWebContainerStore.getState().shellQueue;
  if (!wc || pending.length === 0) return;
  useWebContainerStore.setState({ shellQueue: [] });
  void (async () => {
    for (const job of pending) {
      if (!wc) break;
      try {
        await runShell(wc, job.command, job.cwd);
      } catch {
        // safeExit already swallows; this is a defensive belt-and-braces
      }
    }
  })().catch(() => {
    // unreachable, but keep promise chain rejection-free
  });
}

function syncStoreToWebContainer(): void {
  if (!wc) return;
  const next = useFileSystemStore.getState().tree;
  void applyTreeDiff(wc, treeSnapshot, next).then(({ packageDepsChanged }) => {
    treeSnapshot = cloneTree(next);
    if (packageDepsChanged) {
      void reinstallAndRestartDev(next);
    }
  });
}

function attachFsSync(): void {
  if (offFsSync) return;
  // ``treeSnapshot`` is the tree we actually mounted in ``startPreview``;
  // do NOT reset it here. The catch-up sync below replays any store
  // writes that landed between mount and server-ready (e.g. the first
  // turn's generated files arriving while ``npm install`` was running).
  offFsSync = useFileSystemStore.subscribe(() => {
    syncStoreToWebContainer();
  });
  syncStoreToWebContainer();
}

/**
 * Re-run ``npm install`` and restart the dev server after ``package.json``
 * dependencies change. Without this, newly added deps (e.g. ``tailwindcss``)
 * are on disk but absent from ``node_modules``, so Next's PostCSS pipeline
 * fails with ``Cannot find module 'tailwindcss'`` the next time the user
 * edits a CSS file. A single-flight lock keeps rapid file writes from
 * stacking overlapping installs.
 */
let reinstallLock = false;
async function reinstallAndRestartDev(latestTree: FileSystemTree): Promise<void> {
  if (!wc) return;
  if (reinstallLock) return;
  reinstallLock = true;
  const instance = wc;
  try {
    useWebContainerStore.setState({ phase: "installing", errorMessage: null });
    try {
      devProc?.kill();
    } catch {
      // ignore
    }
    devProc = null;

    const install = await instance.spawn("npm", ["install"], { output: true });
    void drainOutput(install.output, "install");
    const installCode = await safeExit(install);
    if (installCode === -1) return;
    if (installCode !== 0) {
      throw new Error(`npm install exited with code ${installCode}`);
    }

    if (!wc) return;
    const devScript = readDevScript(latestTree);
    if (!devScript) return;
    useWebContainerStore.setState({ phase: "startingDev" });
    devProc = await instance.spawn("sh", ["-c", devScript], { output: true });
    void drainOutput(devProc.output, "dev");
    void safeExit(devProc);
  } catch (err) {
    useWebContainerStore.setState({
      phase: "error",
      errorMessage:
        err instanceof Error ? err.message : "Reinstall after package.json change failed",
    });
  } finally {
    reinstallLock = false;
  }
}

function detachFsSync(): void {
  if (typeof offFsSync === "function") {
    offFsSync();
  }
  offFsSync = null;
}

// WebContainer.boot() may only be invoked ONCE per page lifetime. Even
// after wc.teardown(), a second boot throws "Only a single WebContainer
// instance can be booted." Cache the boot promise on globalThis so it
// survives both repeated startPreview calls (project switches, retry)
// and Next.js dev-mode HMR re-evaluating this module.
async function getOrBootWebContainer(): Promise<WebContainer> {
  type GlobalWithBoot = typeof globalThis & {
    __micracodeWcBoot?: Promise<WebContainer>;
  };
  const g = globalThis as GlobalWithBoot;
  if (!g.__micracodeWcBoot) {
    const { WebContainer } = await import("@webcontainer/api");
    g.__micracodeWcBoot = WebContainer.boot({ coep: "require-corp" });
  }
  return g.__micracodeWcBoot;
}

// Detach listeners and kill the dev process WITHOUT calling
// wc.teardown(). The WebContainer instance is reused for the page
// lifetime; treeSnapshot is preserved so the next startPreview can
// diff against what's actually on disk inside the container.
function softReset(): void {
  detachFsSync();
  try {
    offServerReady?.();
  } catch {
    // ignore
  }
  offServerReady = null;
  try {
    devProc?.kill();
  } catch {
    // ignore
  }
  devProc = null;
}

export const useWebContainerStore = create<WebContainerState & WebContainerActions>((set, get) => ({
  phase: "idle",
  previewUrl: null,
  errorMessage: null,
  shellQueue: [],
  output: [],

  stopPreview: (projectId) => {
    if (isDesktop() && projectId) {
      void window.electronAPI.stopDevServer(projectId);
    }
    softReset();
    set({
      phase: "idle",
      previewUrl: null,
      errorMessage: null,
    });
  },

  enqueueShell: (command, cwd) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    if (get().phase === "ready" && wc) {
      void runShell(wc, trimmed, cwd);
      return;
    }
    set((s) => ({ shellQueue: [...s.shellQueue, { command: trimmed, cwd }] }));
  },

  clearOutput: () => set({ output: [] }),

  getRecentErrors: (limit = 40) => {
    const errs = get().output.filter((l) => l.isError);
    return errs.length > limit ? errs.slice(errs.length - limit) : errs;
  },

  startPreview: async (projectId) => {
    if (typeof window === "undefined") return;
    if (startLock) return;
    if (get().phase !== "idle" && get().phase !== "error") return;

    const tree = useFileSystemStore.getState().tree;
    const devScript = readDevScript(tree);
    if (!devScript) {
      set({
        phase: "error",
        errorMessage:
          "Preview needs a package.json with a non-empty \"scripts.dev\" entry. Generate a Next.js (or Node) app first.",
        previewUrl: null,
      });
      return;
    }

    // Desktop mode: delegate dev server management to Electron main process
    if (isDesktop() && projectId) {
      set({ phase: "installing", errorMessage: null, previewUrl: null, output: [] });
      try {
        const url = await window.electronAPI.startDevServer(projectId, devScript);
        set({ previewUrl: url, phase: "ready" });
      } catch (err) {
        set({
          phase: "error",
          previewUrl: null,
          errorMessage: err instanceof Error ? err.message : "Failed to start dev server",
        });
      }
      return;
    }

    startLock = true;
    lineCarry = "";
    set({ phase: "booting", errorMessage: null, previewUrl: null, output: [] });

    try {
      softReset();

      set({ phase: "mounting" });
      wc = await getOrBootWebContainer();

      offServerReady = wc.on("server-ready", (_port, url) => {
        set({ previewUrl: url, phase: "ready" });
        flushShellQueue();
        attachFsSync();
      });

      // applyTreeDiff handles both the first mount (treeSnapshot is {})
      // and subsequent project switches (removes stale files from the
      // previous project, writes new ones).
      await applyTreeDiff(wc, treeSnapshot, tree);
      treeSnapshot = cloneTree(tree);

      set({ phase: "installing" });
      const install = await wc.spawn("npm", ["install"], { output: true });
      void drainOutput(install.output, "install");
      const installCode = await safeExit(install);
      if (installCode === -1) {
        // process was killed; bail without erroring
        return;
      }
      if (installCode !== 0) {
        throw new Error(`npm install exited with code ${installCode}`);
      }

      set({ phase: "startingDev" });
      devProc = await wc.spawn("sh", ["-c", devScript], { output: true });
      void drainOutput(devProc.output, "dev");
      // Observe dev exit so a crash doesn't surface as an unhandled rejection.
      void safeExit(devProc);
    } catch (err) {
      softReset();
      set({
        phase: "error",
        previewUrl: null,
        errorMessage: err instanceof Error ? err.message : "WebContainer failed to start",
      });
    } finally {
      startLock = false;
    }
  },
}));
