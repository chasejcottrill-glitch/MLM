const { app, BrowserWindow, desktopCapturer, session, shell } = require('electron');

const APP_URL = process.env.GENRE_APP_URL || 'https://genre-organizer-visualizer-production.up.railway.app';
const TRUSTED_ORIGIN = new URL(APP_URL).origin;

function isTrusted(url) {
  try {
    return new URL(url).origin === TRUSTED_ORIGIN;
  } catch {
    return false;
  }
}

async function createWindow() {
  const ses = session.defaultSession;

  // Windows-only system audio loopback. Electron/Chromium captures the already-rendered
  // system output; this does not access or decrypt Apple Music's protected media stream.
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false
      });
      const primary = sources[0];
      if (!primary) return callback({});
      callback({ video: primary, audio: 'loopback' });
    } catch {
      callback({});
    }
  });

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    if (!isTrusted(webContents.getURL())) return callback(false);
    callback(permission === 'media' || permission === 'display-capture');
  });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#080808',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrusted(url)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  await win.loadURL(APP_URL);
}

app.whenReady().then(async () => {
  await createWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
