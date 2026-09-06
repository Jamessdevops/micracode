/**
 * Per-turn checkpoints, backed by a plain git repo inside each project folder.
 *
 * The model: one commit per turn boundary. `capture()` runs just before a turn
 * edits files, so each commit is the "pre-turn" tree — the state the UI lets
 * you revert back to ("undo this message"). Restore is `git reset --hard` +
 * `clean`, which also drops any later commits, so the checkpoint list (git log)
 * stays the single source of truth with no orphan state to reason about.
 *
 * node_modules / .next / dist / .micracode are gitignored: they're rebuildable
 * or hold the chat log itself (reverting must not rewrite the history that let
 * you revert), and keeping them out makes commits and `clean` cheap and safe.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Storage } from "./storage.js";

// Matches apps/web/src/lib/api/generated/Checkpoint.ts.
export interface Checkpoint {
  id: string;
  label: string;
  created_at: number; // unix seconds
  files_changed: number;
  insertions: number;
  deletions: number;
}

export type ChangeKind = "added" | "modified" | "deleted" | "renamed" | "conflicted";
export interface FileChange {
  path: string;
  status: ChangeKind;
}
export interface VcsStatus {
  files: FileChange[];
  clean: boolean;
}

const GITIGNORE = "node_modules/\n.next/\ndist/\n.micracode/\n";
// Commit as a fixed bot identity via -c so we never depend on (or touch) the
// user's global git config.
const IDENTITY = [
  "-c",
  "user.name=Micracode",
  "-c",
  "user.email=bot@micracode.local",
];

function gitRaw(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Trimmed for callers that want a single token (sha) or clean multi-line body.
// NB: never use this to parse `status --porcelain` — trimming eats the leading
// status-column space and shifts every path by one char (see status()).
function git(dir: string, args: string[]): string {
  return gitRaw(dir, args).trim();
}

export class Checkpoints {
  constructor(private readonly storage: Storage) {}

  private dir(projectId: string): string {
    return this.storage.projectDir(projectId);
  }

  private ensureRepo(dir: string): void {
    if (fs.existsSync(path.join(dir, ".git"))) return;
    git(dir, ["init", "-q"]);
    fs.writeFileSync(path.join(dir, ".gitignore"), GITIGNORE, "utf8");
    git(dir, ["add", "-A"]);
    git(dir, [...IDENTITY, "commit", "-q", "-m", "baseline", "--allow-empty"]);
  }

  /**
   * Commit the current tree as a checkpoint and return the resulting HEAD sha.
   * A clean tree makes no new commit (no empty commits) but still returns the
   * existing HEAD — the pre-turn state to revert to is the last checkpoint.
   */
  capture(projectId: string, label: string): string {
    const dir = this.dir(projectId);
    this.ensureRepo(dir);
    git(dir, ["add", "-A"]);
    if (git(dir, ["status", "--porcelain"])) {
      const msg = (label || "checkpoint").slice(0, 200);
      git(dir, [...IDENTITY, "commit", "-q", "-m", msg]);
    }
    return git(dir, ["rev-parse", "HEAD"]);
  }

  list(projectId: string): Checkpoint[] {
    const dir = this.dir(projectId);
    if (!fs.existsSync(path.join(dir, ".git"))) return [];
    // One pass: a record-separator per commit, then its numstat rows.
    const raw = git(dir, [
      "log",
      "--numstat",
      "--pretty=format:\x1e%H\x1f%ct\x1f%s",
    ]);
    const out: Checkpoint[] = [];
    for (const block of raw.split("\x1e")) {
      if (!block.trim()) continue;
      const [head, ...rows] = block.split("\n");
      const [id, ct, subject] = head!.split("\x1f");
      let files = 0;
      let ins = 0;
      let del = 0;
      for (const row of rows) {
        if (!row.trim()) continue;
        const [a, d] = row.split("\t");
        files++;
        ins += Number(a) || 0; // binary files show "-" -> 0
        del += Number(d) || 0;
      }
      out.push({
        id: id!,
        label: subject ?? "",
        created_at: Number(ct) || 0,
        files_changed: files,
        insertions: ins,
        deletions: del,
      });
    }
    return out;
  }

  status(projectId: string): VcsStatus {
    const dir = this.dir(projectId);
    if (!fs.existsSync(path.join(dir, ".git"))) return { files: [], clean: true };
    // Untrimmed: the first column is a space for worktree-only changes, and
    // trimming would drop it and misalign the path slice.
    const porcelain = gitRaw(dir, ["status", "--porcelain"]);
    const files: FileChange[] = [];
    for (const line of porcelain.split("\n")) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      const p = line.slice(3).trim();
      files.push({ path: p, status: kindOf(code) });
    }
    return { files, clean: files.length === 0 };
  }

  /** Diff a checkpoint against its parent (the change it introduced). */
  diff(projectId: string, sha: string): string {
    const dir = this.dir(projectId);
    // The root checkpoint has no parent; diff against git's empty tree so it
    // shows as all-added instead of erroring on `<sha>~1`.
    const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let base = `${sha}~1`;
    try {
      git(dir, ["rev-parse", "--verify", "-q", `${sha}^`]);
    } catch {
      base = EMPTY_TREE;
    }
    return git(dir, ["diff", base, sha]);
  }

  /** Restore the working tree to a checkpoint, dropping any later commits. */
  restore(projectId: string, sha: string): void {
    const dir = this.dir(projectId);
    git(dir, ["reset", "--hard", sha]);
    git(dir, ["clean", "-fd"]); // remove files created after the checkpoint
  }
}

function kindOf(code: string): ChangeKind {
  if (code.includes("U") || code === "AA" || code === "DD") return "conflicted";
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A") || code === "??") return "added";
  return "modified";
}
