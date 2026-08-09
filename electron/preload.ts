import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  dialog: {
    showMessageBox: (options: Electron.MessageBoxOptions) => 
      ipcRenderer.invoke('dialog:showMessageBox', options),
    showOpenDialog: (options: Electron.OpenDialogOptions) => 
      ipcRenderer.invoke('dialog:showOpenDialog', options),
    showSaveDialog: (options: Electron.SaveDialogOptions) => 
      ipcRenderer.invoke('dialog:showSaveDialog', options),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    quit: () => ipcRenderer.invoke('app:quit'),
  },
  server: {
    restart: () => ipcRenderer.invoke('server:restart'),
  },
  update: {
    install: () => ipcRenderer.invoke('update:install'),
    onAvailable: (callback: (info: any) => void) => {
      ipcRenderer.on('update:available', (_, info) => callback(info));
    },
    onDownloaded: (callback: (info: any) => void) => {
      ipcRenderer.on('update:downloaded', (_, info) => callback(info));
    },
  },
});

declare global {
  interface Window {
    electronAPI: {
      dialog: {
        showMessageBox: (options: Electron.MessageBoxOptions) => Promise<Electron.MessageBoxReturnValue>;
        showOpenDialog: (options: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>;
        showSaveDialog: (options: Electron.SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>;
      };
      shell: {
        openExternal: (url: string) => Promise<void>;
      };
      app: {
        getVersion: () => Promise<string>;
        quit: () => Promise<void>;
      };
      server: {
        restart: () => Promise<void>;
      };
      update: {
        install: () => Promise<void>;
        onAvailable: (callback: (info: any) => void) => void;
        onDownloaded: (callback: (info: any) => void) => void;
      };
    };
  }
}