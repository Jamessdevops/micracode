"use client";

import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  File as FileIcon,
  FilePlus,
  FolderPlus,
  RefreshCw,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { getProjectFiles } from "@/lib/api/projects";
import { cn } from "@/lib/utils";
import {
  flattenFileSystemTree,
  useFileSystemStore,
} from "@/store/fileSystemStore";
import { usePreviewStore } from "@/store/previewStore";

export interface FileTreeSidebarProps {
  projectId: string;
  projectName?: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

type TreeNode =
  | { kind: "dir"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string };

function buildTree(paths: { path: string }[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode[]>();
  dirMap.set("", root);

  const sorted = [...paths].sort((a, b) => a.path.localeCompare(b.path));

  for (const { path } of sorted) {
    const segments = path.split("/").filter(Boolean);
    let currentPath = "";
    let currentChildren = root;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const isLast = i === segments.length - 1;
      const nextPath = currentPath ? `${currentPath}/${seg}` : seg;

      if (isLast) {
        currentChildren.push({ kind: "file", name: seg, path: nextPath });
      } else {
        let dir = currentChildren.find(
          (n) => n.kind === "dir" && n.name === seg,
        ) as Extract<TreeNode, { kind: "dir" }> | undefined;
        if (!dir) {
          dir = { kind: "dir", name: seg, path: nextPath, children: [] };
          currentChildren.push(dir);
          dirMap.set(nextPath, dir.children);
        }
        currentChildren = dir.children;
      }
      currentPath = nextPath;
    }
  }

  // Put directories before files at every level.
  const sortLevel = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.kind === "dir") sortLevel(n.children);
    }
  };
  sortLevel(root);
  return root;
}

function GitStatusBadge({ status }: { status: "U" | "M" | null }) {
  if (!status) return null;
  return (
    <span
      className={cn(
        "ml-2 shrink-0 font-mono text-[10px] font-semibold",
        status === "U" ? "text-green-500" : "text-blue-500",
      )}
      aria-label={status === "U" ? "untracked" : "modified"}
    >
      {status}
    </span>
  );
}

function FileRow({
  node,
  depth,
  selected,
  status,
  onSelect,
}: {
  node: Extract<TreeNode, { kind: "file" }>;
  depth: number;
  selected: boolean;
  status: "U" | "M" | null;
  onSelect: (path: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      className={cn(
        "group flex w-full items-center rounded-md py-1 pr-2 text-left text-xs transition",
        selected
          ? "bg-zinc-800 text-zinc-50"
          : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50",
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
      title={node.path}
    >
      <FileIcon className="mr-1.5 size-3.5 shrink-0 text-zinc-500" />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      <GitStatusBadge status={status} />
    </button>
  );
}

function DirRow({
  node,
  depth,
  open,
  onToggle,
}: {
  node: Extract<TreeNode, { kind: "dir" }>;
  depth: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center rounded-md py-1 pr-2 text-left text-xs text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-50"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      {open ? (
        <ChevronDown className="mr-1 size-3.5 shrink-0 text-zinc-500" />
      ) : (
        <ChevronRight className="mr-1 size-3.5 shrink-0 text-zinc-500" />
      )}
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export function FileTreeSidebar({
  projectId,
  projectName,
  selectedPath,
  onSelect,
}: FileTreeSidebarProps) {
  const tree = useFileSystemStore((s) => s.tree);
  const writtenAt = useFileSystemStore((s) => s.writtenAt);
  const hydratedPaths = useFileSystemStore((s) => s.hydratedPaths);
  const replaceTree = useFileSystemStore((s) => s.replaceTree);
  const startPreview = usePreviewStore((s) => s.startPreview);
  const previewPhase = usePreviewStore((s) => s.phase);

  const isPreviewBooting = previewPhase === "starting";

  const files = useMemo(() => flattenFileSystemTree(tree), [tree]);
  const roots = useMemo(() => buildTree(files), [files]);

  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});
  const [isRefreshing, setIsRefreshing] = useState(false);

  const toggleDir = useCallback((path: string) => {
    setOpenDirs((prev) => ({ ...prev, [path]: !prev[path] }));
  }, []);

  const statusFor = useCallback(
    (path: string): "U" | "M" | null => {
      if (!writtenAt[path]) return null;
      return hydratedPaths.has(path) ? "M" : "U";
    },
    [writtenAt, hydratedPaths],
  );

  const collapseAll = useCallback(() => {
    setOpenDirs({});
  }, []);

  const refresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const { tree: fresh } = await getProjectFiles(projectId);
      replaceTree(fresh);
      void startPreview(projectId);
    } catch {
      // Non-fatal.
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, projectId, replaceTree, startPreview]);

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode => {
    return nodes.map((node) => {
      if (node.kind === "file") {
        return (
          <li key={node.path}>
            <FileRow
              node={node}
              depth={depth}
              selected={selectedPath === node.path}
              status={statusFor(node.path)}
              onSelect={onSelect}
            />
          </li>
        );
      }
      const isOpen = openDirs[node.path] ?? false;
      return (
        <li key={node.path}>
          <DirRow
            node={node}
            depth={depth}
            open={isOpen}
            onToggle={() => toggleDir(node.path)}
          />
          {isOpen ? (
            <ul className="space-y-0.5">
              {renderNodes(node.children, depth + 1)}
            </ul>
          ) : null}
        </li>
      );
    });
  };

  const headerLabel = (projectName?.trim() || projectId).slice(0, 18);

  return (
    <aside className="flex h-full w-[250px] shrink-0 flex-col border-r border-zinc-800 bg-[#0E0E11]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 px-2 text-xs">
        <span className="truncate font-mono uppercase tracking-wider text-zinc-400">
          {headerLabel} ...
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="inline-flex size-6 items-center justify-center rounded text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-50"
            aria-label="New file"
            title="New file"
          >
            <FilePlus className="size-3.5" />
          </button>
          <button
            type="button"
            className="inline-flex size-6 items-center justify-center rounded text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-50"
            aria-label="New folder"
            title="New folder"
          >
            <FolderPlus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={isRefreshing || isPreviewBooting}
            className="inline-flex size-6 items-center justify-center rounded text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-50 disabled:opacity-50"
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw
              className={cn(
                "size-3.5",
                (isRefreshing || isPreviewBooting) && "animate-spin",
              )}
            />
          </button>
          <button
            type="button"
            onClick={collapseAll}
            className="inline-flex size-6 items-center justify-center rounded text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-50"
            aria-label="Collapse all"
            title="Collapse all"
          >
            <ChevronsDownUp className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {roots.length === 0 ? (
          <p className="p-4 text-center text-xs text-zinc-500">
            No files yet
          </p>
        ) : (
          <ul className="space-y-0.5">{renderNodes(roots, 0)}</ul>
        )}
      </div>
    </aside>
  );
}
