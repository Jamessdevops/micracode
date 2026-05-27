"use client";

import { Box, Loader2 } from "lucide-react";

import { PanelShell } from "@/components/layout/PanelShell";
import { PreviewConsole } from "@/components/preview/PreviewConsole";
import { isDesktop } from "@/lib/desktop";
import {
  useWebContainerStore,
  type WebContainerPhase,
} from "@/store/webContainerStore";

const LOADING_PHASES: ReadonlySet<WebContainerPhase> = new Set([
  "idle",
  "booting",
  "mounting",
  "installing",
  "startingDev",
]);

const PHASE_LABEL: Record<WebContainerPhase, string> = {
  idle: "Loading preview…",
  booting: "Booting sandbox…",
  mounting: "Mounting project files…",
  installing: "Installing dependencies…",
  startingDev: "Starting dev server…",
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
}

/**
 * WebContainer-backed live preview: mounts the Zustand file tree, installs
 * dependencies, runs `package.json`'s `scripts.dev`, and embeds the URL from
 * the `server-ready` event. File edits stream into the sandbox while running.
 */
export function PreviewPanel({
  chrome = true,
  showConsole = true,
}: PreviewPanelProps) {
  const phase = useWebContainerStore((s) => s.phase);
  const previewUrl = useWebContainerStore((s) => s.previewUrl);
  const errorMessage = useWebContainerStore((s) => s.errorMessage);

  const isolated =
    typeof window !== "undefined" ? Boolean(window.crossOriginIsolated) : true;

  const inner = (
    <div className="flex h-full min-h-0 flex-col">
        {!isolated && !isDesktop() ? (
          <div className="shrink-0 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            This origin is not cross-origin isolated (`crossOriginIsolated` is false).
            WebContainers need COOP/COEP; confirm dev is served from this Next app, not a
            proxied origin.
          </div>
        ) : null}

        {phase === "error" && errorMessage ? (
          <div className="shrink-0 border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {errorMessage}
          </div>
        ) : null}

        <div className="relative min-h-0 flex-1 bg-muted/30">
          {previewUrl ? (
            <>
              <iframe
                title="WebContainer preview"
                src={previewUrl}
                className="h-full w-full border-0"
                allow="cross-origin-isolated"
              />
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
                  {isDesktop()
                    ? "Preview runs your project's dev server locally, then embeds it here."
                    : "Run preview mounts your virtual files into a StackBlitz WebContainer, runs npm install and your scripts.dev command, then opens the dev server URL here. Edits in the editor sync while the preview is running."}
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
