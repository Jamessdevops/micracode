"use client";

import { Database } from "lucide-react";
import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  EditorTopBar,
  type WorkspaceTab,
} from "@/components/editor/EditorTopBar";
import { EditorShortcutsEmpty } from "@/components/editor/EditorShortcutsEmpty";
import { FileTreeSidebar } from "@/components/editor/FileTreeSidebar";
import { PreviewConsole } from "@/components/preview/PreviewConsole";
import { PreviewPanel } from "@/components/preview/PreviewPanel";
import { updateProjectFile } from "@/lib/api/projects";
import {
  flattenFileSystemTree,
  useFileSystemStore,
} from "@/store/fileSystemStore";

import type { MonacoEditorPaneProps } from "./MonacoEditorPane";

const MonacoEditorPane = dynamic(
  () => import("./MonacoEditorPane").then((m) => m.MonacoEditorPane),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full min-h-[12rem] items-center justify-center text-xs text-zinc-500">
        Loading editor…
      </div>
    ),
  },
) as ComponentType<MonacoEditorPaneProps>;

export interface V0WorkspacePanelProps {
  projectId: string;
  projectName?: string;
}

export function V0WorkspacePanel({
  projectId,
  projectName,
}: V0WorkspacePanelProps) {
  const [tab, setTab] = useState<WorkspaceTab>("preview");
  const [selected, setSelected] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const tree = useFileSystemStore((s) => s.tree);
  const upsertFile = useFileSystemStore((s) => s.upsertFile);
  const writtenAt = useFileSystemStore((s) => s.writtenAt);
  const files = useMemo(() => flattenFileSystemTree(tree), [tree]);

  const editorRef = useRef<
    import("monaco-editor").editor.IStandaloneCodeEditor | null
  >(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<{ path: string; content: string } | null>(
    null,
  );

  // Sync selection when file list changes.
  useEffect(() => {
    if (selected && !files.some((f) => f.path === selected)) {
      setSelected(null);
    }
  }, [files, selected]);

  const flushSave = useCallback(
    async (path: string | null) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const ed = editorRef.current;
      if (!ed || !path) return;
      const content = ed.getValue();
      pendingSaveRef.current = { path, content };
      upsertFile(path, content);
      try {
        await updateProjectFile(projectId, { path, content });
        setSaveError(null);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Save failed");
      }
    },
    [projectId, upsertFile],
  );

  const schedulePersist = useCallback(
    (path: string, content: string) => {
      pendingSaveRef.current = { path, content };
      upsertFile(path, content);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const pending = pendingSaveRef.current;
        saveTimerRef.current = null;
        if (!pending) return;
        void updateProjectFile(projectId, {
          path: pending.path,
          content: pending.content,
        })
          .then(() => setSaveError(null))
          .catch((err) => {
            setSaveError(err instanceof Error ? err.message : "Save failed");
          });
      }, 500);
    },
    [projectId, upsertFile],
  );

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  const handleSelectFile = useCallback(
    (path: string) => {
      if (path === selected) {
        if (tab !== "code") setTab("code");
        return;
      }
      void flushSave(selected);
      setSelected(path);
      if (tab !== "code") setTab("code");
    },
    [flushSave, selected, tab],
  );

  const handleMountEditor = useCallback(
    (editor: import("monaco-editor").editor.IStandaloneCodeEditor) => {
      editorRef.current = editor;
    },
    [],
  );

  const active = files.find((f) => f.path === selected) ?? null;

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#0E0E11]">
      <EditorTopBar
        activeTab={tab}
        onTabChange={setTab}
        urlText="/"
        onRefresh={() => setReloadKey((k) => k + 1)}
      />

      <div className="flex min-h-0 flex-1">
        {tab === "code" ? (
          <FileTreeSidebar
            projectId={projectId}
            projectName={projectName}
            selectedPath={selected}
            onSelect={handleSelectFile}
          />
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#0E0E11]">
          {tab === "code" ? (
            <>
              {active ? (
                <>
                  <div className="flex h-8 shrink-0 items-center justify-between border-b border-zinc-800 px-3 text-xs text-zinc-400">
                    <span className="truncate font-mono text-zinc-300">
                      {active.path}
                    </span>
                    {writtenAt[active.path] ? (
                      <span className="text-[10px] text-zinc-500">
                        updated{" "}
                        {new Date(writtenAt[active.path]!).toLocaleTimeString()}
                      </span>
                    ) : null}
                  </div>
                  {saveError ? (
                    <p className="shrink-0 border-b border-red-900/50 bg-red-950/30 px-3 py-1 text-[11px] text-red-300">
                      {saveError}
                    </p>
                  ) : null}
                  <div className="min-h-0 flex-1">
                    <MonacoEditorPane
                      filePath={active.path}
                      contents={active.content}
                      onChangeContents={(value) =>
                        schedulePersist(active.path, value)
                      }
                      onMountEditor={handleMountEditor}
                    />
                  </div>
                </>
              ) : (
                <div className="min-h-0 flex-1">
                  <EditorShortcutsEmpty />
                </div>
              )}
              <PreviewConsole />
            </>
          ) : null}

          {tab === "preview" ? (
            <div className="min-h-0 flex-1">
              <PreviewPanel
                projectId={projectId}
                chrome={false}
                showConsole={false}
                reloadKey={reloadKey}
              />
            </div>
          ) : null}

          {tab === "database" ? (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <div className="flex flex-col items-center gap-3">
                <div className="inline-flex size-12 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-500">
                  <Database className="size-5" />
                </div>
                <p className="text-sm font-medium text-zinc-300">
                  No database connected
                </p>
                <p className="max-w-sm text-xs text-zinc-500">
                  Connect a Postgres/Supabase database to browse tables and run
                  queries from inside the workspace.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
