import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Checkpoints } from "../src/checkpoints.js";
import { Storage } from "../src/storage.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ckpt-"));
  roots.push(root);
  const storage = new Storage(root);
  const project = storage.createProject("demo");
  return { storage, checkpoints: new Checkpoints(storage), id: project.id };
}

describe("Checkpoints (git-per-turn)", () => {
  test("capture -> list -> restore round-trips the working tree", () => {
    const { storage, checkpoints, id } = fixture();
    const hello = path.join(storage.projectDir(id), "app/hello.tsx");

    // Turn 1: checkpoint the pre-turn tree (starter), then the agent adds a file.
    const pre = checkpoints.capture(id, "add hello");
    expect(pre).toBeTruthy();
    storage.writeFile(id, "app/hello.tsx", "export const Hello = () => null;");

    // Turn 2: checkpoint again — this commit now holds turn 1's new file.
    checkpoints.capture(id, "make it loud");
    expect(fs.existsSync(hello)).toBe(true);

    const list = checkpoints.list(id);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0]!.label).toBe("make it loud"); // newest first

    // Restore to the pre-turn-1 snapshot: the added file must be gone.
    checkpoints.restore(id, pre);
    expect(fs.existsSync(hello)).toBe(false);
  });

  test("diff works for both root and later checkpoints", () => {
    const { storage, checkpoints, id } = fixture();
    const list0 = checkpoints.list(id).length === 0;
    const root = checkpoints.capture(id, "root");
    expect(checkpoints.diff(id, root)).toContain("+"); // root vs empty tree
    expect(list0).toBe(true);

    storage.writeFile(id, "app/hello.tsx", "export const Hello = () => null;");
    const next = checkpoints.capture(id, "add hello");
    const diff = checkpoints.diff(id, next);
    expect(diff).toContain("app/hello.tsx");
    expect(diff).toContain("+export const Hello");
  });

  test("status reports the full path of a worktree change", () => {
    const { storage, checkpoints, id } = fixture();
    checkpoints.capture(id, "base");
    storage.writeFile(id, "app/page.tsx", "export default () => <p>edited</p>;");
    const status = checkpoints.status(id);
    expect(status.clean).toBe(false);
    // Regression: a trimmed porcelain line dropped the leading path char.
    expect(status.files.some((f) => f.path === "app/page.tsx")).toBe(true);
  });

  test("capture is idempotent on a clean tree (no empty commits)", () => {
    const { checkpoints, id } = fixture();
    const a = checkpoints.capture(id, "first");
    const b = checkpoints.capture(id, "no-op");
    expect(b).toBe(a); // same HEAD, no new commit
    expect(checkpoints.status(id).clean).toBe(true);
  });
});
