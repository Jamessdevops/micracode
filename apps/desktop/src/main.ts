import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
} from "electron";
import { spawn, execSync, ChildProcess } from "child_process";
import { createServer as createNetServer } from "net";
import * as path from "path";
import * as fs from "fs";
import { autoUpdater } from "electron-updater";
import type { CoreServer } from "@micracode/core";
import { startProxy, type DevProxy } from "./proxy";

// ---------------------------------------------------------------------------
// Simple JSON file store (replaces electron-store to avoid ESM issues)
// ---------------------------------------------------------------------------

interface StoreData {
  backendPort: number;
}

const DEFAULT_STORE: StoreData = { backendPort: 49152 };

function getStorePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function readStore(): StoreData {
  try {
    const raw = fs.readFileSync(getStorePath(), "utf8");
    return { ...DEFAULT_STORE, ...(JSON.parse(raw) as Partial<StoreData>) };
  } catch {
    return { ...DEFAULT_STORE };
  }
}

function writeStore(data: Partial<StoreData>): void {
  const current = readStore();
  const next = { ...current, ...data };
  fs.mkdirSync(path.dirname(getStorePath()), { recursive: true });
  fs.writeFileSync(getStorePath(), JSON.stringify(next, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// The core backend (@micracode/core) runs in-process, inside this main
// process — not as a spawned child.
let coreServer: CoreServer | null = null;
let backendPort = DEFAULT_STORE.backendPort;
let mainWindow: BrowserWindow | null = null;

// Per-project dev server processes: projectId → ChildProcess
const devServers = new Map<string, ChildProcess>();
// Per-project reverse proxies sitting in front of each dev server.
const devProxies = new Map<string, DevProxy>();

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getWebDistPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "web");
  }
  // Dev: use the Next.js static export relative to the monorepo root
  return path.join(__dirname, "..", "..", "..", "apps", "web", "out");
}

// ---------------------------------------------------------------------------
// Custom app:// protocol — serves Next.js static export
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

// ---------------------------------------------------------------------------
// Core backend lifecycle (in-process)
// ---------------------------------------------------------------------------

// @micracode/core is ESM; this file compiles to CommonJS. A plain `import()`
// would be transpiled to `require()` and fail on the ESM package, so load it
// through a Function to keep a real runtime dynamic import.
const importCore = new Function("s", "return import(s)") as (
  s: string
) => Promise<typeof import("@micracode/core")>;

async function startBackend(): Promise<void> {
  // Keys live in the shared auth.json; core reads it via readAuth() on start.
  const { startCoreServer } = await importCore("@micracode/core");
  coreServer = await startCoreServer({
    host: "127.0.0.1",
    port: 0, // pick a free port; read the real one back below
  });
  backendPort = coreServer.port;
  writeStore({ backendPort });
}

async function stopBackend(): Promise<void> {
  if (coreServer) {
    await coreServer.close();
    coreServer = null;
  }
}

// ---------------------------------------------------------------------------
// Dev server lifecycle
// ---------------------------------------------------------------------------

// Ask the OS for an unused TCP port by binding to 0 and reading it back.
// ponytail: tiny TOCTOU window between close and next's bind; Next won't retry
// an explicit PORT, so a lost race surfaces as an early non-zero exit below.
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

// Forward a chunk of dev-server output to the renderer console. Split into
// lines there; here we just relay raw chunks tagged with their project + source.
function sendLog(projectId: string, source: "install" | "dev", chunk: string): void {
  mainWindow?.webContents.send("dev-server-log", { projectId, source, chunk });
}

// Pipe a child's stdout+stderr to the renderer console. Also drains the pipes —
// an unread stdout buffer can otherwise fill and stall the child.
function streamLogs(
  projectId: string,
  proc: ChildProcess,
  source: "install" | "dev"
): void {
  proc.stdout?.on("data", (d: Buffer) => sendLog(projectId, source, d.toString()));
  proc.stderr?.on("data", (d: Buffer) => sendLog(projectId, source, d.toString()));
}

async function startDevServer(
  projectId: string,
  devScript: string
): Promise<string> {
  // Kill any existing server for this project
  stopDevServer(projectId);

  // Fetch the project root path from the backend
  const resp = await fetch(
    `http://127.0.0.1:${backendPort}/v1/projects/${projectId}`
  );
  if (!resp.ok) throw new Error(`Project not found: ${projectId}`);
  const project = (await resp.json()) as { root_path: string };
  const cwd = project.root_path;

  // Run npm install first, streaming its output to the console. Non-fatal on
  // failure (install may have partially succeeded); capped at 2 min.
  await new Promise<void>((resolve) => {
    const install = spawn("npm", ["install", "--prefer-offline"], {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    streamLogs(projectId, install, "install");
    const killer = setTimeout(() => install.kill(), 120_000);
    const done = () => {
      clearTimeout(killer);
      resolve();
    };
    install.on("exit", done);
    install.on("error", done);
  });

  // Assign a free, unique port. A pinned port (e.g. 3000) collides with the
  // platform's own dev server and with other projects, and Next won't retry a
  // busy port that's set explicitly — so the server would never come up.
  const port = await getFreePort();
  const url = `http://localhost:${port}`;

  // Spawn the dev server. The starter's dev script honors PORT (no --port flag).
  const proc = spawn("npm", ["run", "dev"], {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port) },
  });

  devServers.set(projectId, proc);
  streamLogs(projectId, proc, "dev");

  // Wait for the known URL to respond, rather than scraping stdout (whose
  // format and chunk boundaries are unreliable). Fail fast if the process dies.
  // Once reachable, stand up a reverse proxy in front and hand the renderer the
  // PROXY url — the iframe embeds that, so framing headers set by the generated
  // app are stripped and the preview always renders.
  return new Promise((resolve, reject) => {
    let settled = false;

    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      devServers.delete(projectId);
      stopDevServer(projectId);
      reject(new Error(`Dev server exited with code ${code}`));
    });

    void (async () => {
      const ready = await waitForDevServer(url, 60_000);
      if (settled) return;
      if (!ready) {
        settled = true;
        stopDevServer(projectId);
        reject(new Error("Dev server did not become reachable within 60s"));
        return;
      }
      try {
        const proxy = await startProxy({ host: "127.0.0.1", port });
        devProxies.set(projectId, proxy);
        settled = true;
        resolve(`http://localhost:${proxy.port}`);
      } catch (err) {
        settled = true;
        stopDevServer(projectId);
        reject(err instanceof Error ? err : new Error("Failed to start preview proxy"));
      }
    })();
  });
}

function stopDevServer(projectId: string): void {
  const proxy = devProxies.get(projectId);
  if (proxy) {
    proxy.close();
    devProxies.delete(projectId);
  }
  const proc = devServers.get(projectId);
  if (proc) {
    proc.kill();
    devServers.delete(projectId);
  }
}

function stopAllDevServers(): void {
  for (const [id] of devServers) {
    stopDevServer(id);
  }
}

// ---------------------------------------------------------------------------
// Renderer source
// ---------------------------------------------------------------------------

// In development we load the running Next.js dev server, so the renderer is a
// React *development* build. react-grab (and any tool that reads dev-only fiber
// info via the React DevTools hook) only works against a dev build — the
// packaged app's static export is a production build where that info is gone.
const DEV_SERVER_URL = process.env.MICRACODE_DEV_URL ?? "http://localhost:3000";

// The URL the window loads. Set to the dev server in development (once it's up),
// otherwise the static export served over app://.
let rendererUrl = "app://./index.html";

async function waitForDevServer(url: string, maxMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // dev server not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [
        `--backend-port=${backendPort}`,
        ...(app.isPackaged ? [] : ["--micracode-dev=1"]),
      ],
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(rendererUrl);
  if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: "detach" });

  // Open external links in the system browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// GUI apps launched from Finder/Dock on macOS (and Linux) inherit a minimal
// PATH without /opt/homebrew/bin, /usr/local/bin, nvm, etc. — so `npm` isn't
// found and dev servers exit 127. Pull the login shell's PATH in and merge it.
// No-op in dev (already launched from a terminal with a full PATH).
function fixPath(): void {
  if (process.platform === "win32" || !app.isPackaged) return;
  try {
    const shellBin = process.env.SHELL || "/bin/bash";
    const out = execSync(`${shellBin} -ilc 'echo -n "$PATH"'`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (out) process.env.PATH = out;
  } catch {
    // Fall back to whatever PATH we have plus the common homebrew locations.
    process.env.PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"]
      .filter(Boolean)
      .join(":");
  }
}

app.whenReady().then(async () => {
  fixPath();
  const webDist = getWebDistPath();

  // Serve the Next.js static export via app://
  protocol.handle("app", (request) => {
    let urlPath = new URL(request.url).pathname;
    // Next.js static export: map / → /index.html, unknown paths → /index.html (SPA fallback)
    if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
    const filePath = path.join(webDist, urlPath);
    if (!fs.existsSync(filePath)) {
      // SPA fallback for client-side routes
      return net.fetch(`file://${path.join(webDist, "index.html")}`);
    }
    return net.fetch(`file://${filePath}`);
  });

  await startBackend();

  // Development: load the Next.js dev server (React dev build → react-grab works).
  // Falls back to the static export if the dev server isn't running.
  if (!app.isPackaged) {
    if (await waitForDevServer(DEV_SERVER_URL)) {
      rendererUrl = DEV_SERVER_URL;
    } else {
      console.warn(
        `[dev] ${DEV_SERVER_URL} not reachable — is 'next dev' running? ` +
          `Loading the static export instead (react-grab won't activate there).`,
      );
    }
  }

  createWindow();

  // Auto-update: check GitHub Releases on launch and download in the background.
  // When ready, prompt to restart now; declining installs on next quit anyway.
  // Packaged builds only (dev has no app-update.yml).
  if (app.isPackaged) {
    autoUpdater.on("update-downloaded", async ({ version }) => {
      const { response } = await dialog.showMessageBox({
        type: "info",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
        title: "Update ready",
        message: `Micracode ${version} is ready to install.`,
        detail: "Restart now to update, or it will install the next time you quit.",
      });
      if (response === 0) autoUpdater.quitAndInstall();
    });
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("[updater]", err);
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopAllDevServers();
  void stopBackend();
});

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle("start-dev-server", async (_event, { projectId, devScript }) => {
  return startDevServer(String(projectId), String(devScript));
});

ipcMain.handle("stop-dev-server", (_event, { projectId }) => {
  stopDevServer(String(projectId));
});

ipcMain.handle("save-api-keys", async (_event, keys: Record<string, string>) => {
  const { writeAuth } = await importCore("@micracode/core");
  for (const [name, value] of Object.entries(keys)) writeAuth(name, value);
  // Restart backend so the new keys take effect immediately
  await stopBackend();
  await startBackend();
});

ipcMain.handle("get-api-keys", async () => {
  const { readAuth } = await importCore("@micracode/core");
  return readAuth();
});

ipcMain.handle("get-backend-port", () => backendPort);
