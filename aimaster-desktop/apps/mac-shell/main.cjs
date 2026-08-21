// macOS wrapper for the apps/mobile server-mastering app.
//
// It loads the *built* mobile SPA (apps/mobile/dist, copied to ./www) in a
// BrowserWindow and nothing else: no preload, no IPC, no python engine. The web
// app runs its WEB fallbacks (Capacitor.isNativePlatform() === false) — file
// <input> for picking, <a download> for saving, navigator.share→download for
// sharing — and talks to the Render mastering API over HTTPS (server CORS '*').
//
// The SPA is served through a custom `app://` scheme rather than file:// so that
// Vite's ES-module <script type=module> tags load (file:// blocks module CORS).
const { app, BrowserWindow, protocol, net, shell, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WWW = path.join(__dirname, 'www');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 460,
    height: 900,
    minWidth: 380,
    minHeight: 620,
    title: 'Loui Mastering',
    backgroundColor: '#0b0d12',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links open in the default browser, never a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL('app://localhost/');
}

app.whenReady().then(() => {
  // Serve ./www over app:// (maps app://localhost/<path> → www/<path>).
  protocol.handle('app', (req) => {
    let rel = decodeURIComponent(new URL(req.url).pathname);
    if (!rel || rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(WWW, rel));
    if (!filePath.startsWith(WWW)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Standard macOS app menu (enables ⌘C/⌘V/⌘Q etc.) without custom logic.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
