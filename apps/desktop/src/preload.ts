import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("__MICRACODE_DESKTOP__", true);

contextBridge.exposeInMainWorld("electronAPI", {
  startDevServer: (projectId: string, devScript: string): Promise<string> =>
    ipcRenderer.invoke("start-dev-server", { projectId, devScript }),

  stopDevServer: (projectId: string): Promise<void> =>
    ipcRenderer.invoke("stop-dev-server", { projectId }),

  saveApiKeys: (keys: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke("save-api-keys", keys),

  getApiKeys: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke("get-api-keys"),

  getBackendPort: (): Promise<number> =>
    ipcRenderer.invoke("get-backend-port"),
});
