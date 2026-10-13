import { app, BrowserWindow, Menu, dialog, shell, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// E2E tests point this at a temp dir so they never touch real data.
if (process.env.FINANCE_E2E_USER_DATA) app.setPath('userData', process.env.FINANCE_E2E_USER_DATA);
// Read by server/db.ts when the server module is first imported (below, after this is set).
process.env.FINANCE_DATA_DIR = app.getPath('userData');

let win: BrowserWindow | null = null;
let baseUrl = '';

async function startServer() {
  const server = await import('../server/index.js');
  server.serveStatic(path.join(app.getAppPath(), 'dist'));
  // Random loopback port: nothing else on the network can reach the API.
  const http = await server.listen(0);
  baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Finance Dashboard',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(baseUrl)) event.preventDefault();
  });
  win.on('closed', () => (win = null));
  void win.loadURL(baseUrl);
}

async function backupDatabase() {
  const { backupDatabase } = await import('../server/maintenance.js');
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Back up database',
    defaultPath: `finance-backup-${new Date().toISOString().slice(0, 10)}.db`,
    filters: [{ name: 'SQLite database', extensions: ['db'] }],
  });
  if (canceled || !filePath) return;
  try {
    backupDatabase(filePath);
    await dialog.showMessageBox({ type: 'info', message: 'Backup saved', detail: filePath });
  } catch (err) {
    dialog.showErrorBox('Backup failed', String((err as Error).message));
  }
}

async function importDatabase() {
  const { validateDatabase, replaceDatabase } = await import('../server/maintenance.js');
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Import database',
    properties: ['openFile'],
    filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite'] }],
  });
  if (canceled || !filePaths[0]) return;
  try {
    validateDatabase(filePaths[0]);
  } catch (err) {
    dialog.showErrorBox('Cannot import this file', String((err as Error).message));
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Replace my data', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Replace all current data with this database?',
    detail: 'Your current database is kept as a backup in the data folder. The app restarts afterwards.',
  });
  if (response !== 0) return;
  try {
    replaceDatabase(filePaths[0]);
  } catch (err) {
    dialog.showErrorBox('Import failed', String((err as Error).message));
  }
  // The connection is closed either way, so restart to reopen it.
  app.relaunch();
  app.exit(0);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Back up database…', click: () => void backupDatabase() },
        { label: 'Import database…', click: () => void importDatabase() },
        { type: 'separator' },
        { label: 'Open data folder', click: () => void shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!win && baseUrl) createWindow();
  });
  app.whenReady().then(async () => {
    try {
      await startServer();
    } catch (err) {
      dialog.showErrorBox('Finance Dashboard failed to start', String((err as Error).stack ?? err));
      app.exit(1);
      return;
    }
    buildMenu();
    createWindow();
  });
}
