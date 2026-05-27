"use client";

import type { FileSystemTree } from "@micracode/shared";
import { useEffect, useMemo, useRef } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";

import { V0ChatPanel } from "@/components/chat/V0ChatPanel";
import { V0WorkspacePanel } from "@/components/editor/V0WorkspacePanel";
import { TopNav } from "@/components/layout/TopNav";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { type PromptRecord } from "@/lib/api/projects";
import { promptsToUIMessages } from "@/lib/api/uiMessage";
import { useHydrateFileSystem } from "@/store/fileSystemStore";
import { useModelStore } from "@/store/modelStore";
import { useUiStore } from "@/store/uiStore";
import { useWebContainerStore } from "@/store/webContainerStore";

export interface WorkspaceShellProps {
  projectId: string;
  projectName?: string;
  initialTree?: FileSystemTree;
  initialPrompts?: PromptRecord[];
  initialPrompt?: string;
}

/**
 * v0-style workspace layout:
 *
 *   | Chat (left, 35%) | Workspace (right, 65%) |
 *
 * The workspace pane hosts its own Preview / Code / Database segmented
 * control plus a file-tree sidebar. Pane sizes are persisted via
 * `react-resizable-panels`' `autoSaveId`.
 */
export function WorkspaceShell({
  projectId,
  projectName,
  initialTree,
  initialPrompts,
  initialPrompt,
}: WorkspaceShellProps) {
  useHydrateFileSystem(initialTree);

  const initialMessages = useMemo(
    () => promptsToUIMessages(initialPrompts),
    [initialPrompts],
  );

  // Automatically boot the WebContainer preview as soon as the workspace
  // mounts so the generated app is visible without requiring the user to
  // click "Run preview". `startPreview` is no-op under Strict Mode thanks to
  // its internal `startLock` + phase guard. When navigating between
  // projects, tear down the previous sandbox first so we don't leak it.
  const startPreview = useWebContainerStore((s) => s.startPreview);
  const stopPreview = useWebContainerStore((s) => s.stopPreview);
  const isPanelOpen = useUiStore((s) => s.isPanelOpen);
  const setIsPanelOpen = useUiStore((s) => s.setIsPanelOpen);
  const workspacePanelRef = useRef<ImperativePanelHandle>(null);

  // Sync store → panel imperatively
  useEffect(() => {
    const panel = workspacePanelRef.current;
    if (!panel) return;
    if (isPanelOpen && panel.isCollapsed()) {
      panel.expand();
    } else if (!isPanelOpen && !panel.isCollapsed()) {
      panel.collapse();
    }
  }, [isPanelOpen]);

  // On mount, sync actual panel state (restored by autoSaveId) → store
  useEffect(() => {
    const panel = workspacePanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) setIsPanelOpen(false);
  }, [setIsPanelOpen]);

  const lastProjectId = useRef<string | null>(null);
  useEffect(() => {
    if (lastProjectId.current && lastProjectId.current !== projectId) {
      stopPreview(lastProjectId.current);
    }
    lastProjectId.current = projectId;
    void startPreview(projectId);
  }, [projectId, startPreview, stopPreview]);

  // Populate the model picker once per workspace mount. The store is
  // module-scoped so reloading on every project navigation is wasteful;
  // `loadCatalog` is itself a no-op when a fetch is already in flight.
  const loadCatalog = useModelStore((s) => s.loadCatalog);
  const catalogLoaded = useModelStore((s) => s.catalog !== null);
  useEffect(() => {
    if (catalogLoaded) return;
    void loadCatalog();
  }, [catalogLoaded, loadCatalog]);

  return (
    <div className="dark flex h-dvh flex-col bg-black text-zinc-50">
      <TopNav projectId={projectId} projectName={projectName} />

      <div className="min-h-0 flex-1">
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="micracode:workspace-v3"
          className="h-full"
        >
          <ResizablePanel defaultSize={35} minSize={25}>
            <V0ChatPanel
              projectId={projectId}
              initialMessages={initialMessages}
              initialPrompt={initialPrompt}
              hasInitialHistory={initialMessages.length > 0}
            />
          </ResizablePanel>

          <ResizableHandle
            className={`bg-transparent after:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 ${!isPanelOpen ? "hidden" : ""}`}
          />

          <ResizablePanel
            ref={workspacePanelRef}
            defaultSize={65}
            minSize={45}
            collapsible
            collapsedSize={0}
            onCollapse={() => setIsPanelOpen(false)}
            onExpand={() => setIsPanelOpen(true)}
            className="border border-[oklch(30.1%_0_0)] rounded-[25px] bg-[#0E0E11]"
          >
            <V0WorkspacePanel
              projectId={projectId}
              projectName={projectName}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
