"use client";

import { Box, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { PanelShell } from "@/components/layout/PanelShell";
import { PreviewConsole } from "@/components/preview/PreviewConsole";
import { cn } from "@/lib/utils";
import { useFileSystemStore } from "@/store/fileSystemStore";
import { useSelectionStore } from "@/store/selectionStore";
import {
  usePreviewStore,
  type PreviewPhase,
} from "@/store/previewStore";

type Rect = { x: number; y: number; width: number; height: number };
type SourceLoc = { path: string; line: number; column: number };
type DomHint = { tag: string; classes: string[]; text: string };
type BridgeMsg =
  | { type: "mc:hover"; rect: Rect; label: string }
  | {
      type: "mc:select";
      rect: Rect;
      label: string;
      source?: SourceLoc;
      component?: string;
      dom: DomHint;
    }
  | { type: "mc:rect"; rect: Rect }
  | { type: "mc:leave" }
  | { type: "mc:clear" };

const basename = (p: string) => p.split(/[/\\]/).pop() ?? p;

const CODE_CAP = 8000;

// A top-level declaration line (no leading indent) that begins a component or
// function: `export default function X`, `function X`, `const X = ...`, etc.
const DECL_RE =
  /^(export\s+)?(default\s+)?(async\s+)?(function\b|const\s+[A-Za-z0-9_$]+\s*[:=])/;

/**
 * "React Grab"-style source grab: given a file's contents and the 1-based line
 * of the clicked element, return the enclosing top-level component/function.
 * Heuristic (no AST): walk up to the nearest unindented declaration, then down
 * to the first line whose first char is `}` at column 0 — the top-level block's
 * close under Prettier-style formatting. Falls back to the whole file if the
 * boundaries can't be found. Truncated to CODE_CAP with a marker.
 */
function grabComponent(content: string, line: number): string {
  const lines = content.split("\n");
  const target = Math.min(Math.max(line - 1, 0), lines.length - 1);

  let start = -1;
  for (let i = target; i >= 0; i--) {
    const l = lines[i]!;
    if (!/^\s/.test(l) && DECL_RE.test(l)) {
      start = i;
      break;
    }
  }
  let end = -1;
  if (start !== -1) {
    for (let i = Math.max(target, start + 1); i < lines.length; i++) {
      if (/^[})]/.test(lines[i]!)) {
        end = i;
        break;
      }
    }
  }

  const snippet =
    start !== -1 && end !== -1
      ? lines.slice(start, end + 1).join("\n")
      : content;
  return snippet.length > CODE_CAP
    ? snippet.slice(0, CODE_CAP) + "\n… (truncated — read the file for the rest)"
    : snippet;
}

/**
 * The target-element block prepended to the codegen prompt. Written as an
 * imperative directive (not a hint) because `source` is usually unknown — most
 * projects have no `data-mc-loc` stamping — so the visible text + tag is the
 * only reliable anchor. Without this the agent tends to edit the most prominent
 * text on the page (a heading) rather than the element the user actually picked.
 */
function selectionBlock(
  source: SourceLoc | undefined,
  component: string | undefined,
  dom: DomHint,
  code: string | undefined,
): string {
  const lines = [
    "The user selected one specific element in the live preview. The request",
    "that follows applies to THIS element ONLY — do not change any other",
    "element, heading, or section.",
    "",
    "Target element:",
  ];
  // Prefer the stamped source location — it uniquely identifies the element.
  // The tag/text below only confirm it. Fall back to text-anchoring when no
  // `data-mc-loc` is present (unstamped projects).
  if (source)
    lines.push(
      `- source: ${source.path}:${source.line} — edit the element at this exact location`,
    );
  lines.push(`- tag: <${dom.tag}>`);
  if (dom.text)
    lines.push(
      source
        ? `- visible text: ${JSON.stringify(dom.text)}`
        : `- visible text: ${JSON.stringify(dom.text)} — locate the element by this exact text`,
    );
  const cls = dom.classes.slice(0, 8).join(" ");
  if (cls) lines.push(`- classes: ${cls}`);
  if (component) lines.push(`- component: <${component}>`);
  lines.push(
    "",
    source
      ? "Edit the element at the source location above; the tag and text confirm it."
      : "If no element matches the tag and text above, ask instead of guessing.",
  );
  if (code && source)
    lines.push(
      "",
      `Current source of the enclosing component (${source.path}):`,
      "```tsx",
      code,
      "```",
    );
  return lines.join("\n");
}

/** Highlight box drawn over the iframe at a bridge-reported rect. */
function Overlay({ rect, selected }: { rect: Rect; selected: boolean }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-10 rounded-sm",
        selected
          ? "border-2 border-primary bg-primary/10"
          : "border border-primary/70 bg-primary/5",
      )}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    />
  );
}

const LOADING_PHASES: ReadonlySet<PreviewPhase> = new Set(["idle", "starting"]);

const PHASE_LABEL: Record<PreviewPhase, string> = {
  idle: "Loading preview…",
  starting: "Starting dev server…",
  ready: "Ready",
  error: "Failed to start",
};

export interface PreviewPanelProps {
  projectId: string;
  /**
   * When false, renders just the panel body (controls + iframe + console)
   * without the PanelShell title-bar chrome. Used by the v0-style workspace
   * where a shared `EditorTopBar` already provides the outer tab strip.
   */
  chrome?: boolean;
  /**
   * When false, the bottom console drawer is not rendered. The workspace
   * renders its own `PreviewConsole` alongside the code editor instead.
   * Defaults to true to preserve standalone usage.
   */
  showConsole?: boolean;
  /** Bumping this remounts the iframe, reloading the preview. */
  reloadKey?: number;
}

/**
 * Live preview: the Electron main process runs the project's real dev server on
 * the machine, puts a local reverse proxy in front of it, and returns the proxy
 * URL, which is embedded here in an `<iframe>`.
 */
export function PreviewPanel({
  chrome = true,
  showConsole = true,
  reloadKey = 0,
}: PreviewPanelProps) {
  const phase = usePreviewStore((s) => s.phase);
  const previewUrl = usePreviewStore((s) => s.previewUrl);
  const errorMessage = usePreviewStore((s) => s.errorMessage);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const selectMode = useSelectionStore((s) => s.selectMode);
  const setSelectMode = useSelectionStore((s) => s.setSelectMode);
  const [hover, setHover] = useState<{ rect: Rect } | null>(null);
  const setPendingSelection = useSelectionStore((s) => s.setPending);

  // Arm/disarm the in-iframe bridge whenever the toggle changes.
  const sendMode = useCallback((enabled: boolean) => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: "mc:set-mode", enabled },
      "*",
    );
  }, []);
  useEffect(() => {
    sendMode(selectMode);
    if (!selectMode) setHover(null);
  }, [selectMode, sendMode]);

  // Receive hover/select from the (cross-origin) bridge. Trust only our iframe.
  useEffect(() => {
    const onMessage = (ev: MessageEvent<BridgeMsg>) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const msg = ev.data;
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "mc:hover") setHover({ rect: msg.rect });
      else if (msg.type === "mc:leave" || msg.type === "mc:clear")
        setHover(null);
      else if (msg.type === "mc:select") {
        // Clicking an element sends it straight to chat as a draft. Grab the
        // enclosing component's current source from the client-side file store
        // (its keys match the stamped data-mc-loc paths) so the agent edits the
        // real code, not a guess anchored on tag/text.
        const file = msg.source
          ? useFileSystemStore.getState().getFile(msg.source.path)
          : undefined;
        const code =
          file && msg.source ? grabComponent(file, msg.source.line) : undefined;
        setPendingSelection({
          block: selectionBlock(msg.source, msg.component, msg.dom, code),
          label:
            (msg.component ? `${msg.component} — ` : "") +
            (msg.source
              ? `${basename(msg.source.path)}:${msg.source.line}`
              : msg.label),
        });
        setHover(null);
        setSelectMode(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [setPendingSelection, setSelectMode]);

  // Escape exits select mode when host (rather than iframe) holds focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHover(null);
        setSelectMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSelectMode]);

  const inner = (
    <div className="flex h-full min-h-0 flex-col">
        {phase === "error" && errorMessage ? (
          <div className="shrink-0 border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {errorMessage}
          </div>
        ) : null}

        <div className="relative min-h-0 flex-1 bg-muted/30">
          {previewUrl ? (
            <>
              <iframe
                key={reloadKey}
                ref={iframeRef}
                title="App preview"
                src={previewUrl}
                onLoad={() => sendMode(selectMode)}
                className="h-full w-full border-0"
              />

              {hover ? <Overlay rect={hover.rect} selected={false} /> : null}

              {LOADING_PHASES.has(phase) ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">
                  <div className="flex items-center gap-2 rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
                    <Loader2 className="size-3.5 animate-spin" />
                    <span>{PHASE_LABEL[phase]}</span>
                  </div>
                </div>
              ) : null}
            </>
          ) : LOADING_PHASES.has(phase) ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
              <p className="text-sm font-medium">{PHASE_LABEL[phase]}</p>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="rounded-full border border-border bg-secondary p-4">
                <Box className="size-6 text-muted-foreground" />
              </div>
              <div className="max-w-sm space-y-1">
                <p className="text-sm font-medium">Live preview</p>
                <p className="text-xs text-muted-foreground">
                  Preview runs your project&apos;s dev server locally, then embeds it here.
                </p>
              </div>
            </div>
          )}
        </div>

        {showConsole ? <PreviewConsole /> : null}
    </div>
  );

  if (!chrome) return inner;
  return <PanelShell title="Preview">{inner}</PanelShell>;
}
