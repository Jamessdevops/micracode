import * as os from "node:os";
import * as path from "node:path";

/**
 * Root directory that holds all projects. Mirrors the Python backend's
 * `OPENER_APPS_DIR` so both backends can point at the same folder.
 */
export function dataRoot(): string {
  const env = process.env.OPENER_APPS_DIR?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), "opener-apps");
}
