// The Windows app itself: opens the window, shows file dialogs, and keeps Kite Reel up to date.
// All editing logic lives in src/ and renderer/; this file is only the parts that need Windows.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const server = require('./src/server');

const APP_ID = 'io.github.direkjames.kitereel';
let win = null, site = null, updater = null, updateState = null, lastFolder = '';

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 620,
    show: false, title: 'Kite Reel', autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181c' : '#eceef2',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  // the window only ever shows Kite Reel's own screen
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(site.url)) event.preventDefault(); });
  win.on('closed', () => { win = null; });
  win.loadURL(site.url);
}

// Only Kite Reel's own screen may ask for these.
const trusted = event => !!(site && event.senderFrame && String(event.senderFrame.url).startsWith(site.url));

const MEDIA = [
  { name: 'Videos, photos and sounds', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mts', 'm2ts', '3gp', 'flv', 'mpg', 'mpeg', 'ts', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'wma'] },
  { name: 'All files', extensions: ['*'] },
];
const PROJECT = [{ name: 'Kite Reel project', extensions: ['kitereel'] }];

// kind 'media': any number of videos, photos and sounds. kind 'project': one project file. Always answers with a list.
ipcMain.handle('pick-open', async (event, kind) => {
  if (!trusted(event) || !win) return [];
  const project = kind === 'project';
  const result = await dialog.showOpenDialog(win, {
    title: project ? 'Open a project' : 'Import media',
    defaultPath: lastFolder || app.getPath(project ? 'documents' : 'videos'),
    properties: project ? ['openFile'] : ['openFile', 'multiSelections'],
    filters: project ? PROJECT : MEDIA,
  });
  if (result.canceled || !result.filePaths.length) return [];
  lastFolder = path.dirname(result.filePaths[0]);
  return result.filePaths;
});

// kind 'video': where to export. kind 'project': where to save the project. Answers with a path, or '' if cancelled.
ipcMain.handle('pick-save', async (event, kind, name) => {
  if (!trusted(event) || !win) return '';
  const project = kind === 'project', ext = project ? 'kitereel' : 'mp4';
  const safe = String(name || (project ? 'My project.kitereel' : 'my-video.mp4')).replace(/[\\/:*?"<>|]/g, '_');
  const result = await dialog.showSaveDialog(win, {
    title: project ? 'Save the project' : 'Save your video',
    defaultPath: path.join(lastFolder || app.getPath(project ? 'documents' : 'videos'), safe),
    filters: project ? PROJECT : [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (result.canceled || !result.filePath) return '';
  return result.filePath.toLowerCase().endsWith('.' + ext) ? result.filePath : `${result.filePath}.${ext}`;
});

ipcMain.on('reveal', (event, file) => { if (trusted(event) && typeof file === 'string' && file) shell.showItemInFolder(file); });
ipcMain.handle('update-state', event => (trusted(event) ? updateState : null));
ipcMain.on('install-update', event => {
  // quit, install without asking questions, and open Kite Reel again
  if (trusted(event) && updater && updateState && updateState.state === 'ready') updater.quitAndInstall(true, true);
});

/* ---------- updates ---------- */
// Kite Reel asks GitHub whether a newer version has been published. If so it downloads it in the background,
// then installs it the next time the app closes, or right away if you press "Restart to update".
function setUpUpdates() {
  if (!app.isPackaged) return;              // only the installed app updates itself
  const logFile = path.join(app.getPath('userData'), 'update.log');
  const log = (level, msg) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${level} ${msg && msg.stack ? msg.stack : msg}\n`); } catch (e) { /* logging is best effort */ } };
  try { if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) fs.rmSync(logFile); } catch (e) { /* ignore */ }
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { log('error', e); return; }
  updater = autoUpdater;
  autoUpdater.logger = { info: m => log('info', m), warn: m => log('warn', m), error: m => log('error', m), debug: () => {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  let found = '';
  const tell = state => { updateState = state; if (win && !win.isDestroyed()) win.webContents.send('update', state); };
  autoUpdater.on('update-available', info => { found = info && info.version ? info.version : ''; tell({ state: 'available', version: found }); });
  autoUpdater.on('download-progress', p => tell({ state: 'downloading', version: found, percent: p && p.percent ? p.percent : 0 }));
  autoUpdater.on('update-downloaded', info => tell({ state: 'ready', version: info && info.version ? info.version : found }));
  autoUpdater.on('update-not-available', () => tell({ state: 'none' }));
  autoUpdater.on('error', err => { log('error', err); if (!updateState || updateState.state !== 'ready') tell({ state: 'error' }); });
  const check = () => { autoUpdater.checkForUpdates().catch(err => log('error', err)); };
  check();
  setInterval(check, 4 * 60 * 60 * 1000);   // and every four hours while the app stays open
}

/* ---------- start ---------- */
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setAppUserModelId(APP_ID);
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { if (site) site.close(); });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try { site = await server.start({ version: app.getVersion(), dataDir: app.getPath('userData') }); }
    catch (err) { dialog.showErrorBox('Kite Reel could not start', String(err && err.message ? err.message : err)); app.quit(); return; }
    createWindow();
    setUpUpdates();
  });
}
