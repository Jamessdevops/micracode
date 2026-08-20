"use client";

import type {
  DirectoryNode,
  FileNode,
  FileSystemTree,
  FlatFile,
} from "@micracode/shared";
import { useEffect, useRef } from "react";
import { create } from "zustand";

/**
 * Single source of truth for the virtual file system.
 *
 * Shape is `FileSystemTree` from @micracode/shared (a nested file/dir map).
 */

export interface FileSystemState {
  tree: FileSystemTree;
  /** Last write timestamp per path, useful for UI diffing. */
  writtenAt: Record<string, number>;
  /**
   * Paths that were present at the last `replaceTree` / hydration.
   * Anything not in this set that later shows up in `writtenAt` is
   * considered "untracked" by the UI (git `U`); anything in this set
   * that shows up in `writtenAt` is "modified" (git `M`).
   */
  hydratedPaths: Set<string>;

  // Mutations -----------------------------------------------------------
  upsertFile: (path: string, content: string) => void;
  deleteFile: (path: string) => void;
  replaceTree: (tree: FileSystemTree) => void;
  reset: () => void;

  // Selectors -----------------------------------------------------------
  getFile: (path: string) => string | undefined;
  getFlatFiles: () => FlatFile[];
}

const EMPTY_TREE: FileSystemTree = {};

// ---------- helpers ---------------------------------------------------------

function splitPath(path: string): string[] {
  return path
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function cloneTree(tree: FileSystemTree): FileSystemTree {
  const next: FileSystemTree = {};
  for (const [name, node] of Object.entries(tree)) {
    if ("file" in node) {
      next[name] = { file: { contents: node.file.contents } };
    } else {
      next[name] = { directory: cloneTree(node.directory) };
    }
  }
  return next;
}

function writeInto(
  tree: FileSystemTree,
  segments: string[],
  content: string,
): FileSystemTree {
  if (segments.length === 0) return tree;
  const next = cloneTree(tree);
  let cursor: FileSystemTree = next;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const existing = cursor[seg];
    if (!existing || "file" in existing) {
      const dir: DirectoryNode = { directory: {} };
      cursor[seg] = dir;
      cursor = dir.directory;
    } else {
      cursor = existing.directory;
    }
  }
  const leaf = segments[segments.length - 1]!;
  const node: FileNode = { file: { contents: content } };
  cursor[leaf] = node;
  return next;
}

function deleteAt(
  tree: FileSystemTree,
  segments: string[],
): FileSystemTree {
  if (segments.length === 0) return tree;
  const next = cloneTree(tree);
  const parents: FileSystemTree[] = [next];
  let cursor: FileSystemTree = next;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const node = cursor[seg];
    if (!node || "file" in node) return tree;
    cursor = node.directory;
    parents.push(cursor);
  }
  const leaf = segments[segments.length - 1]!;
  if (!(leaf in cursor)) return tree;
  delete cursor[leaf];
  // Optionally prune empty parent directories.
  for (let i = segments.length - 2; i >= 0; i--) {
    const parent = parents[i]!;
    const name = segments[i]!;
    const child = parent[name];
    if (child && "directory" in child && Object.keys(child.directory).length === 0) {
      delete parent[name];
    } else {
      break;
    }
  }
  return next;
}

/** Pure flatten for UI lists; subscribe to `tree` in Zustand and memoize on it. */
export function flattenFileSystemTree(
  tree: FileSystemTree,
  prefix = "",
  acc: FlatFile[] = [],
): FlatFile[] {
  for (const [name, node] of Object.entries(tree)) {
    const p = prefix ? `${prefix}/${name}` : name;
    if ("file" in node) {
      const c = node.file.contents;
      acc.push({ path: p, content: typeof c === "string" ? c : "" });
    } else {
      flattenFileSystemTree(node.directory, p, acc);
    }
  }
  return acc;
}

function readAt(tree: FileSystemTree, segments: string[]): string | undefined {
  let cursor: FileSystemTree = tree;
  for (let i = 0; i < segments.length - 1; i++) {
    const node = cursor[segments[i]!];
    if (!node || "file" in node) return undefined;
    cursor = node.directory;
  }
  const leaf = cursor[segments[segments.length - 1]!];
  if (!leaf || !("file" in leaf)) return undefined;
  return typeof leaf.file.contents === "string" ? leaf.file.contents : undefined;
}

// ---------- store -----------------------------------------------------------

export const useFileSystemStore = create<FileSystemState>((set, get) => ({
  tree: EMPTY_TREE,
  writtenAt: {},
  hydratedPaths: new Set<string>(),

  upsertFile: (path, content) => {
    const segments = splitPath(path);
    if (segments.length === 0) return;
    set((state) => ({
      tree: writeInto(state.tree, segments, content),
      writtenAt: { ...state.writtenAt, [path]: Date.now() },
    }));
  },

  deleteFile: (path) => {
    const segments = splitPath(path);
    if (segments.length === 0) return;
    set((state) => {
      const nextWrittenAt = { ...state.writtenAt };
      delete nextWrittenAt[path];
      return {
        tree: deleteAt(state.tree, segments),
        writtenAt: nextWrittenAt,
      };
    });
  },

  replaceTree: (tree) => {
    const cloned = cloneTree(tree);
    const paths = new Set(flattenFileSystemTree(cloned).map((f) => f.path));
    set({ tree: cloned, writtenAt: {}, hydratedPaths: paths });
  },

  reset: () =>
    set({ tree: EMPTY_TREE, writtenAt: {}, hydratedPaths: new Set<string>() }),

  getFile: (path) => {
    const segments = splitPath(path);
    if (segments.length === 0) return undefined;
    return readAt(get().tree, segments);
  },

  getFlatFiles: () => flattenFileSystemTree(get().tree),
}));

/**
 * One-shot hydrator used by the workspace page to seed the store from
 * data pre-fetched on the server. The tree is applied exactly once per
 * mount so in-flight local edits aren't clobbered on re-render.
 */
export function useHydrateFileSystem(initial: FileSystemTree | undefined): void {
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    useFileSystemStore.getState().replaceTree(initial ?? {});
  }, [initial]);
}
