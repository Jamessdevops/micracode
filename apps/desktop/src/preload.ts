import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__MICRACODE_DESKTOP__", true);

// The backend's port is chosen at startup and handed over as a launch
// argument, so the renderer knows where to send API calls on first paint.
const portArg = process.argv.find((a) => a.startsWith("--backend-port="));
contextBridge.exposeInMainWorld(
  "__MICRACODE_API_BASE__",
  portArg ? `http://127.0.0.1:${portArg.split("=")[1]}` : ""
);

// Dev-only signal: the app runs an unpackaged build. Gates renderer dev tools
// (react-grab) that can't rely on NODE_ENV, since the loaded web bundle is a
// production static export.
contextBridge.exposeInMainWorld(
  "__MICRACODE_DEV__",
  process.argv.includes("--micracode-dev=1")
);

contextBridge.exposeInMainWorld("electronAPI", {
  startDevServer: (projectId: string, devScript: string): Promise<string> =>
    ipcRenderer.invoke("start-dev-server", { projectId, devScript }),

  stopDevServer: (projectId: string): Promise<void> =>
    ipcRenderer.invoke("stop-dev-server", { projectId }),

  // Subscribe to raw dev-server log chunks. Returns an unsubscribe fn.
  onDevServerLog: (
    cb: (log: { projectId: string; source: "install" | "dev"; chunk: string }) => void
  ): (() => void) => {
    const listener = (
      _e: unknown,
      log: { projectId: string; source: "install" | "dev"; chunk: string }
    ): void => cb(log);
    ipcRenderer.on("dev-server-log", listener);
    return () => ipcRenderer.removeListener("dev-server-log", listener);
  },

  saveApiKeys: (keys: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke("save-api-keys", keys),

  getApiKeys: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke("get-api-keys"),

  getBackendPort: (): Promise<number> =>
    ipcRenderer.invoke("get-backend-port"),
});
