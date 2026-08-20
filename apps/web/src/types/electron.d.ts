interface ElectronAPI {
  startDevServer(projectId: string, devScript: string): Promise<string>;
  stopDevServer(projectId: string): Promise<void>;
  onDevServerLog(
    cb: (log: { projectId: string; source: "install" | "dev"; chunk: string }) => void,
  ): () => void;
  saveApiKeys(keys: Record<string, string>): Promise<void>;
  getApiKeys(): Promise<Record<string, string>>;
  getBackendPort(): Promise<number>;
}

declare global {
  interface Window {
    __MICRACODE_DESKTOP__?: boolean;
    electronAPI: ElectronAPI;
  }
}

export {};
