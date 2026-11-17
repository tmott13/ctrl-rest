// Ctrl+Rest: Electron main process.
// Loads the Angular build, wires the SmartSpectra IPC bridge, and hands the
// renderer your Presage API key from .env (never hard-coded, never committed).

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

// Read PRESAGE_API_KEY from .env in the project root, if it exists.
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.warn('[ctrl-rest] Could not read .env:', err.message);
  }
}

const indexHtml = path.join(__dirname, '..', 'dist', 'ctrl-rest', 'browser', 'index.html');
const iconPath = path.join(__dirname, '..', 'build', 'icon.png');

function createWindow() {
  // Fit comfortably on small laptops (a 13-inch MacBook is about 1440x900).
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1100, Math.round(sw * 0.8)),
    height: Math.min(760, Math.round(sh * 0.88)),
    minWidth: 720,
    minHeight: 560,
    title: 'Ctrl+Rest',
    icon: iconPath, // Windows and Linux window icon
    backgroundColor: '#1d2433',
    webPreferences: {
      // Our preload loads the SmartSpectra bridge and adds one tiny API
      // (getApiKey). It needs require(), so the preload is not sandboxed.
      // Context isolation stays on, and the window only ever loads our own
      // bundled files.
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  bindSmartSpectraIpc(win);

  // Never navigate away from the bundled app or open new windows.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(indexHtml);
}

app.whenReady().then(() => {
  // Mochi in the Dock while running from source (packaged builds use build/icon.png).
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(iconPath);
  app.setName('Ctrl+Rest');

  // Camera access only for our own bundled page. Everything else is denied.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    callback(permission === 'media' && url.startsWith('file://'));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => {
    return permission === 'media' && String(origin || '').startsWith('file://');
  });

  ipcMain.handle('ctrl-rest:api-key', () => process.env.PRESAGE_API_KEY || '');

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
