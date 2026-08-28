/**
 * Projects on disk (see docs/projects-on-disk.md): each project is a
 * folder under the data root with
 * a `.micracode/` sidecar holding `project.json` and `prompts.jsonl`. The
 * project id is the folder slug.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { dataRoot } from "./config.js";
import { NEXT_STARTER_FILES } from "./starter.js";

// WebContainer-compatible file tree (mirrors @micracode/shared's FileSystemTree;
// inlined to keep this package free of the shared workspace's build settings).
type FileNode = { file: { contents: string } };
type DirectoryNode = { directory: FileSystemTree };
export type FileSystemTree = Record<string, FileNode | DirectoryNode>;

export interface ProjectRecord {
  id: string;
  name: string;
  template: string;
  created_at: string;
  updated_at: string;
}

export type PromptRole = "user" | "assistant" | "system" | "tool";

export interface PromptRecord {
  id: string;
  role: PromptRole;
  content: string;
  created_at: string;
  snapshot_id?: string | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const IGNORED = new Set(["node_modules", ".git", ".micracode", ".next", "dist"]);

function slugify(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "project";
  return base;
}

export class Storage {
  constructor(private readonly root: string = dataRoot()) {}

  ensureRoot(): void {
    fs.mkdirSync(this.root, { recursive: true });
  }

  projectDir(id: string): string {
    return path.join(this.root, id);
  }

  private metaPath(id: string): string {
    return path.join(this.projectDir(id), ".micracode", "project.json");
  }

  private promptsPath(id: string): string {
    return path.join(this.projectDir(id), ".micracode", "prompts.jsonl");
  }

  getProject(id: string): ProjectRecord | null {
    if (!SLUG_RE.test(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(id), "utf8")) as ProjectRecord;
    } catch {
      return null;
    }
  }

  listProjects(): ProjectRecord[] {
    this.ensureRoot();
    const out: ProjectRecord[] = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rec = this.getProject(entry.name);
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  createProject(name: string, template = "next"): ProjectRecord {
    this.ensureRoot();
    let id = slugify(name);
    let n = 2;
    while (fs.existsSync(this.projectDir(id))) id = `${slugify(name)}-${n++}`;
    const now = new Date().toISOString();
    const rec: ProjectRecord = { id, name, template, created_at: now, updated_at: now };
    fs.mkdirSync(path.join(this.projectDir(id), ".micracode"), { recursive: true });
    fs.writeFileSync(this.metaPath(id), JSON.stringify(rec, null, 2), "utf8");
    // Scaffold the Next.js starter so the preview can `npm run dev` immediately,
    // before the agent writes anything. Other templates start empty.
    if (template === "next") {
      for (const [rel, content] of Object.entries(NEXT_STARTER_FILES)) {
        this.writeFile(id, rel, content);
      }
    }
    return rec;
  }

  deleteProject(id: string): boolean {
    if (this.getProject(id) === null) return false;
    fs.rmSync(this.projectDir(id), { recursive: true, force: true });
    return true;
  }

  readTree(id: string): FileSystemTree {
    const walk = (dir: string): FileSystemTree => {
      const tree: FileSystemTree = {};
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (IGNORED.has(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          tree[entry.name] = { directory: walk(abs) };
        } else if (entry.isFile()) {
          tree[entry.name] = { file: { contents: fs.readFileSync(abs, "utf8") } };
        }
      }
      return tree;
    };
    return walk(this.projectDir(id));
  }

  writeFile(id: string, rel: string, content: string): void {
    const safe = rel.replace(/\\/g, "/").replace(/^\/+/, "");
    if (safe.split("/").includes("..")) throw new Error("path escapes project");
    const abs = path.join(this.projectDir(id), safe);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    this.touch(id);
  }

  readPrompts(id: string): PromptRecord[] {
    try {
      return fs
        .readFileSync(this.promptsPath(id), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PromptRecord);
    } catch {
      return [];
    }
  }

  appendPrompt(id: string, role: PromptRole, content: string): PromptRecord {
    const rec: PromptRecord = {
      id: `p_${Date.now().toString(36)}`,
      role,
      content,
      created_at: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(this.promptsPath(id)), { recursive: true });
    fs.appendFileSync(this.promptsPath(id), JSON.stringify(rec) + "\n", "utf8");
    this.touch(id);
    return rec;
  }

  private touch(id: string): void {
    const rec = this.getProject(id);
    if (!rec) return;
    rec.updated_at = new Date().toISOString();
    fs.writeFileSync(this.metaPath(id), JSON.stringify(rec, null, 2), "utf8");
  }
}
