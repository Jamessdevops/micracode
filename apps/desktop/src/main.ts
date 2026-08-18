import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  shell,
} from "electron";
import { execSync, spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { CoreServer } from "@micracode/core";

// ---------------------------------------------------------------------------
// Simple JSON file store (replaces electron-store to avoid ESM issues)
// ---------------------------------------------------------------------------

interface StoreData {
  apiKeys: Record<string, string>;
  backendPort: number;
}

const DEFAULT_STORE: StoreData = { apiKeys: {}, backendPort: 49152 };

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
// process — not as a spawned child like the old Python binary.
let coreServer: CoreServer | null = null;
let backendPort = DEFAULT_STORE.backendPort;
let mainWindow: BrowserWindow | null = null;

// Per-project dev server processes: projectId → ChildProcess
const devServers = new Map<string, ChildProcess>();

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
  const apiKeys = readStore().apiKeys;
  const { startCoreServer } = await importCore("@micracode/core");
  coreServer = await startCoreServer({
    host: "127.0.0.1",
    port: 0, // pick a free port; read the real one back below
    apiKeys,
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

const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/;

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

  // Run npm install first (blocking, up to 2 min)
  try {
    execSync("npm install --prefer-offline", { cwd, timeout: 120_000, stdio: "pipe" });
  } catch {
    // Non-fatal — continue anyway; npm install may have partially succeeded
  }

  // Spawn the dev server
  const proc = spawn("npm", ["run", "dev"], {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  devServers.set(projectId, proc);

  // Detect the URL from stdout/stderr
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Dev server did not report a URL within 30s"));
    }, 30_000);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      const match = URL_PATTERN.exec(text);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        devServers.delete(projectId);
        reject(new Error(`Dev server exited with code ${code}`));
      }
    });
  });
}

function stopDevServer(projectId: string): void {
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

app.whenReady().then(async () => {
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

ipcMain.handle("save-api-keys", (_event, keys: Record<string, string>) => {
  writeStore({ apiKeys: keys });
  // Restart backend so the new keys take effect immediately
  const restart = async () => {
    await stopBackend();
    await startBackend();
  };
  void restart();
});

ipcMain.handle("get-api-keys", () => {
  return readStore().apiKeys;
});

ipcMain.handle("get-backend-port", () => backendPort);
