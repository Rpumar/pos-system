export interface ElectronHardwarePrinterApi {
  listPorts: () => Promise<Array<{ port: string; manufacturer?: string; pnpId?: string }>>;
  getConfig: () => Promise<{ portPath: string; baudRate: number; paperWidth: '58' | '80' } | null>;
  setConfig: (config: unknown) => Promise<{ portPath: string; baudRate: number; paperWidth: '58' | '80' }>;
  print: (content: string) => Promise<{ ok: true }>;
  status: () => Promise<{ status: string; error?: string | null }>;
  openCashDrawer: () => Promise<{ ok: true }>;
  test: (content?: string) => Promise<{ ok: true }>;
}

export interface ElectronApi {
  dialog: {
    showMessageBox: (options: unknown) => Promise<{ response: number; checkboxChecked: boolean }>;
    showOpenDialog: (options: unknown) => Promise<{ canceled: boolean; filePaths: string[] }>;
    showSaveDialog: (options: unknown) => Promise<{ canceled: boolean; filePath?: string }>;
  };
  shell: { openExternal: (url: string) => Promise<void> };
  app: { getVersion: () => Promise<string>; quit: () => Promise<void> };
  server: { restart: () => Promise<void> };
  update: {
    install: () => Promise<void>;
    onAvailable: (callback: (info: unknown) => void) => void;
    onDownloaded: (callback: (info: unknown) => void) => void;
  };
  hardware: {
    printer: ElectronHardwarePrinterApi;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronApi;
  }
}
