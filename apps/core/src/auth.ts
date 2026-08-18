/**
 * Persistent API-key store — one dedicated file, shared with the Python
 * backend so a key entered in either place is visible to both.
 *
 *   $XDG_DATA_HOME/micracode/auth.json   (default ~/.local/share/micracode/…)
 *
 * Shape: a flat map of env-var name → value, e.g. { "OPENAI_API_KEY": "sk-…" },
 * so loading it is just `Object.assign(process.env, readAuth())`. Dir 0700,
 * file 0600 — it holds secrets.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function authFile(): string {
  const dataHome =
    process.env.XDG_DATA_HOME?.trim() ||
    path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "micracode", "auth.json");
}

export function readAuth(): Record<string, string> {
  try {
    const data = JSON.parse(fs.readFileSync(authFile(), "utf8")) as Record<
      string,
      unknown
    >;
    return Object.fromEntries(
      Object.entries(data).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
  } catch {
    return {}; // missing or malformed → no keys
  }
}

export function writeAuth(name: string, value: string): void {
  const file = authFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = { ...readAuth(), [name]: value };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600); // writeFileSync mode is ignored when the file already exists
}

// self-check: `bun apps/core/src/auth.ts`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-auth-"));
  process.env.XDG_DATA_HOME = tmp;
  console.assert(Object.keys(readAuth()).length === 0, "missing file → {}");
  writeAuth("OPENAI_API_KEY", "sk-test");
  writeAuth("GOOGLE_API_KEY", "g");
  const a = readAuth();
  console.assert(
    a.OPENAI_API_KEY === "sk-test" && a.GOOGLE_API_KEY === "g",
    "round-trip + merge preserves other keys",
  );
  console.assert(
    (fs.statSync(authFile()).mode & 0o777) === 0o600,
    "file mode is 0600",
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("auth.ts self-check ok");
}
