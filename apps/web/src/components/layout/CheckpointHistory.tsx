"use client";

import { ChevronDown, ChevronRight, History, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useState } from "react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { getProjectFiles } from "@/lib/api/projects";
import {
  type Checkpoint,
  getCheckpointDiff,
  listCheckpoints,
  revertCheckpoint,
} from "@/lib/api/vcs";
import { useFileSystemStore } from "@/store/fileSystemStore";

/** "just now" / "5m ago" / "3h ago" / "2d ago" from a unix-seconds timestamp. */
function ago(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Color a unified-diff line: additions green, deletions red, hunks/meta dim. */
function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-emerald-400";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-red-400";
  if (line.startsWith("@@")) return "text-sky-400";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("+++") ||
    line.startsWith("---")
  )
    return "text-zinc-500";
  return "text-zinc-400";
}

export function CheckpointHistory({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Checkpoint[] | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ id: string; text: string } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const toggleDiff = useCallback(
    async (id: string) => {
      if (expanded === id) {
        setExpanded(null);
        return;
      }
      setExpanded(id);
      if (diff?.id === id) return; // cached
      setDiffLoading(true);
      try {
        const { diff: text } = await getCheckpointDiff(projectId, id);
        setDiff({ id, text });
      } catch (err) {
        setDiff({ id, text: `Failed to load diff: ${err}` });
      } finally {
        setDiffLoading(false);
      }
    },
    [projectId, expanded, diff],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await listCheckpoints(projectId));
    } catch (err) {
      setError(String(err));
      setItems([]);
    }
  }, [projectId]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        void load(); // refetch each time it opens
      } else {
        setExpanded(null); // collapse diffs when closed
      }
    },
    [load],
  );

  const onRevert = useCallback(
    async (id: string) => {
      if (reverting) return;
      setReverting(id);
      setError(null);
      try {
        await revertCheckpoint(projectId, id);
        const { tree } = await getProjectFiles(projectId);
        useFileSystemStore.getState().replaceTree(tree);
        setExpanded(null);
        setDiff(null);
        await load(); // reverted-past checkpoints are gone from history
      } catch (err) {
        setError(String(err));
      } finally {
        setReverting(null);
      }
    },
    [projectId, reverting, load],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <button
          aria-label="Checkpoint history"
          title="Checkpoint history"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-50"
        >
          <History className="size-4" />
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-96 border-zinc-800 bg-[#0E0E11] text-zinc-50">
        <SheetHeader>
          <SheetTitle className="text-zinc-50">Checkpoints</SheetTitle>
          <SheetDescription className="text-zinc-400">
            A snapshot is saved before each turn. Restore rolls the project back
            and drops anything after that point.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-2 overflow-auto">
          {error ? <p className="text-sm text-red-400">{error}</p> : null}

          {items === null ? (
            <p className="text-sm text-zinc-400">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-zinc-400">No checkpoints yet.</p>
          ) : (
            items.map((ch, i) => (
              <div
                key={ch.id}
                className="rounded-md border border-zinc-800 bg-black/40"
              >
                <div className="flex items-start justify-between gap-2 p-3">
                  <button
                    onClick={() => void toggleDiff(ch.id)}
                    className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
                    title="Show changes"
                  >
                    {expanded === ch.id ? (
                      <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-zinc-500" />
                    ) : (
                      <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-zinc-500" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-zinc-100" title={ch.label}>
                        {ch.label || "checkpoint"}
                      </span>
                      <span className="mt-0.5 block text-xs text-zinc-500">
                        {ago(ch.created_at)}
                        {i === 0 ? " · latest" : ""}
                        {ch.files_changed
                          ? ` · ${ch.files_changed} file${ch.files_changed > 1 ? "s" : ""}`
                          : ""}
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={() => void onRevert(ch.id)}
                    disabled={reverting !== null}
                    title="Restore this checkpoint"
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2 text-xs text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {reverting === ch.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="size-3.5" />
                    )}
                    Restore
                  </button>
                </div>

                {expanded === ch.id ? (
                  <div className="border-t border-zinc-800">
                    {diffLoading && diff?.id !== ch.id ? (
                      <p className="p-3 text-xs text-zinc-500">Loading diff…</p>
                    ) : (diff?.text ?? "").trim() === "" ? (
                      <p className="p-3 text-xs text-zinc-500">No changes in this checkpoint.</p>
                    ) : (
                      <pre className="max-h-72 overflow-auto p-3 font-mono text-[11px] leading-relaxed">
                        {(diff?.text ?? "").split("\n").map((line, li) => (
                          <div key={li} className={diffLineClass(line)}>
                            {line || " "}
                          </div>
                        ))}
                      </pre>
                    )}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
