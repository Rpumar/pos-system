import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { autoUpdater } from 'electron-updater';

let mainWindow: BrowserWindow | null = null;
let serverProcess: ReturnType<typeof spawn> | null = null;
let isQuitting = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    title: 'POS System',
    icon: join(__dirname, '..', 'build-resources', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.js'),
    },
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startServer(): void {
  const serverDir = app.isPackaged
    ? join(process.resourcesPath, 'server')
    : join(__dirname, '..', 'server');
  const serverPath = join(serverDir, 'dist', 'index.js');

  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: '1',
      PORT: process.env.PORT ?? '3001',
      POS_SERVER_DB_PATH: join(app.getPath('userData'), 'pos-server.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout?.on('data', (data) => {
    console.log(`[Server] ${data.toString().trim()}`);
  });

  serverProcess.stderr?.on('data', (data) => {
    console.error(`[Server Error] ${data.toString().trim()}`);
  });

  serverProcess.on('close', (code) => {
    console.log(`[Server] Process exited with code ${code}`);
    if (!isQuitting && code !== 0) {
      console.log('[Server] Restarting in 5 seconds...');
      setTimeout(startServer, 5000);
    }
  });
}

function setupAutoUpdater(): void {
  autoUpdater.checkForUpdatesAndNotify();
  
  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version);
    mainWindow?.webContents.send('update:available', info);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded:', info.version);
    mainWindow?.webContents.send('update:downloaded', info);
  });

  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater] Error:', err);
  });

  ipcMain.on('update:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });
}

function setupIpc(): void {
  ipcMain.handle('dialog:showMessageBox', async (_, options) => {
    const result = await dialog.showMessageBox(mainWindow!, options);
    return result;
  });

  ipcMain.handle('dialog:showOpenDialog', async (_, options) => {
    const result = await dialog.showOpenDialog(mainWindow!, options);
    return result;
  });

  ipcMain.handle('dialog:showSaveDialog', async (_, options) => {
    const result = await dialog.showSaveDialog(mainWindow!, options);
    return result;
  });

  ipcMain.handle('shell:openExternal', async (_, url) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('app:getVersion', () => {
    return app.getVersion();
  });

  ipcMain.handle('app:quit', () => {
    isQuitting = true;
    app.quit();
  });

  ipcMain.handle('server:restart', () => {
    if (serverProcess) {
      serverProcess.kill();
    }
    startServer();
  });
}

app.whenReady().then(() => {
  startServer();
  setupAutoUpdater();
  setupIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (serverProcess) {
    serverProcess.kill();
  }
});

process.on('uncaughtException', (error) => {
  console.error('[Uncaught Exception]', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});