"use client";

import type { FileSystemTree } from "@micracode/shared";
import { create } from "zustand";

import { isDesktop } from "@/lib/desktop";
import { flattenFileSystemTree, useFileSystemStore } from "@/store/fileSystemStore";

export type PreviewPhase = "idle" | "starting" | "ready" | "error";

export type OutputSource = "install" | "dev" | "shell";

export interface OutputLine {
  id: number;
  source: OutputSource;
  text: string;
  isError: boolean;
  at: number;
}

interface PreviewState {
  phase: PreviewPhase;
  previewUrl: string | null;
  errorMessage: string | null;
  /** The project whose dev-server logs the console is currently showing. */
  activeProjectId: string | null;
  /** Line-buffered dev-server output (install + dev), newest last. */
  output: OutputLine[];
}

interface PreviewActions {
  startPreview: (projectId?: string) => Promise<void>;
  stopPreview: (projectId?: string) => void;
  enqueueShell: (command: string, cwd?: string) => void;
  clearOutput: () => void;
}

const OUTPUT_BUFFER_CAP = 200;

// Loose heuristics that flag a line as "error-like" for console styling.
// False positives are cheaper than false negatives here.
const ERROR_PATTERNS: RegExp[] = [
  /\berror\b/i,
  /\bERR_/i,
  /\bEADDRINUSE\b/,
  /\bENOENT\b/,
  /error TS\d+:/,
  /Module not found/i,
  /Cannot find module/i,
  /SyntaxError|TypeError|ReferenceError/,
  /Failed to compile/i,
];

function looksLikeError(line: string): boolean {
  return line.trim().length > 0 && ERROR_PATTERNS.some((re) => re.test(line));
}

// Dev-server chunks aren't line-aligned; carry the trailing partial line per
// source until the next chunk completes it, so one logical line isn't split.
let outputSeq = 0;
const lineCarry: Record<OutputSource, string> = { install: "", dev: "", shell: "" };

function appendChunk(source: OutputSource, chunk: string): void {
  const combined = lineCarry[source] + chunk;
  const parts = combined.split(/\r?\n/);
  lineCarry[source] = parts.pop() ?? "";
  const now = Date.now();
  const additions: OutputLine[] = [];
  for (const raw of parts) {
    const text = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ""); // strip ANSI
    if (!text) continue;
    additions.push({ id: ++outputSeq, source, text, isError: looksLikeError(text), at: now });
  }
  if (additions.length === 0) return;
  usePreviewStore.setState((state) => {
    const merged = [...state.output, ...additions];
    const overflow = merged.length - OUTPUT_BUFFER_CAP;
    return { output: overflow > 0 ? merged.slice(overflow) : merged };
  });
}

function resetCarry(): void {
  lineCarry.install = "";
  lineCarry.dev = "";
  lineCarry.shell = "";
}

// Subscribe once to the Electron main process's dev-server log stream. Guarded
// against HMR re-subscribing via a global flag.
function ensureLogSubscription(): void {
  if (typeof window === "undefined" || !window.electronAPI?.onDevServerLog) return;
  const g = globalThis as typeof globalThis & { __micracodeLogSub?: boolean };
  if (g.__micracodeLogSub) return;
  g.__micracodeLogSub = true;
  window.electronAPI.onDevServerLog(({ projectId, source, chunk }) => {
    // Only surface logs for the preview the console is currently showing.
    if (projectId !== usePreviewStore.getState().activeProjectId) return;
    appendChunk(source, chunk);
  });
}

function readDevScript(tree: FileSystemTree): string | null {
  const pkg = flattenFileSystemTree(tree).find((f) => f.path === "package.json");
  if (!pkg) return null;
  try {
    const parsed = JSON.parse(pkg.content) as { scripts?: Record<string, string> };
    const dev = parsed.scripts?.dev;
    return typeof dev === "string" && dev.trim().length > 0 ? dev.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Live preview: the Electron main process runs the project's real dev server on
 * the machine, puts a local reverse proxy in front of it, and hands back the
 * proxy URL — which `PreviewPanel` embeds in an `<iframe>`. Dev-server stdout is
 * streamed back over IPC into `output` for the console. Desktop-only; a plain
 * browser has no process to run the dev server.
 */
export const usePreviewStore = create<PreviewState & PreviewActions>((set, get) => ({
  phase: "idle",
  previewUrl: null,
  errorMessage: null,
  activeProjectId: null,
  output: [],

  startPreview: async (projectId) => {
    if (typeof window === "undefined") return;
    if (get().phase === "starting") return;

    if (!isDesktop() || !projectId) {
      set({
        phase: "error",
        previewUrl: null,
        errorMessage: "Live preview runs the project's dev server locally — open Micracode in the desktop app.",
      });
      return;
    }

    const devScript = readDevScript(useFileSystemStore.getState().tree);
    if (!devScript) {
      set({
        phase: "error",
        previewUrl: null,
        errorMessage:
          'Preview needs a package.json with a non-empty "scripts.dev" entry. Generate a Next.js (or Node) app first.',
      });
      return;
    }

    ensureLogSubscription();
    resetCarry();
    set({ phase: "starting", errorMessage: null, previewUrl: null, activeProjectId: projectId, output: [] });
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
  },

  stopPreview: (projectId) => {
    if (isDesktop() && projectId) {
      void window.electronAPI.stopDevServer(projectId);
    }
    set({ phase: "idle", previewUrl: null, errorMessage: null, activeProjectId: null });
  },

  // ponytail: shell commands emitted by the model were a WebContainer-era hook
  // (run inside the sandbox). The desktop's npm install + dev server are managed
  // by the Electron main process, so these are dropped. Wire to an IPC exec
  // handler if we ever resurface model-driven shell commands.
  enqueueShell: () => {},

  clearOutput: () => set({ output: [] }),
}));
