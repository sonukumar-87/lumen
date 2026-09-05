// Lumen — Electron main process.
// Responsibilities:
//   • Create a frameless, transparent, always-on-top window
//   • Hide it from screen capture (the Cluely trick)
//   • Wire up global hotkeys
//   • Provide a getDisplayMedia handler so the renderer can call it
//   • Bridge a few IPC calls (hide, quit, open System Settings panes)

const { app, BrowserWindow, globalShortcut, ipcMain, session,
        desktopCapturer, screen, Menu, shell, systemPreferences,
        protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

// Register `lumen://` as a privileged secure standard scheme so the renderer
// loads from a real, secure origin (not `file://`). Chromium's Web Speech
// chunked-upload pipeline rejects `file://` origins, which manifests as the
// `OnSizeReceived failed with Error: -2` storm we saw on mic activation.
// This call must run before `app.ready` fires.
protocol.registerSchemesAsPrivileged([{
  scheme: 'lumen',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

// macOS system-audio loopback (the "Them" channel via getDisplayMedia) does not
// start on Electron 31–38 unless these Chromium features are enabled; without
// them getDisplayMedia rejects with "Error starting capture" and the other
// participant's audio silently never arrives. Electron 39+ wires this up
// itself, where this is a harmless no-op. Must run before `app.ready` fires.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}

// Single-instance lock: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

let win = null;
let clickThrough = false;
let opacityTweenTimer = null;
let currentWindowOpacity = 1.0;

// Map renderer-facing opacity levels (1..100) to BrowserWindow.setOpacity
// fractions (0.01..1.00). Defense in depth — main never trusts the wire
// payload blindly, so any out-of-range value collapses to fully opaque.
function clampOpacity(level) {
  const n = Number(level);
  if (!Number.isFinite(n)) return 1.0;
  const i = Math.round(n);
  if (i < 1 || i > 100) return 1.0;
  return i / 100;
}

function createWindow() {
  const { width: sw, height: shh } = screen.getPrimaryDisplay().workAreaSize;
  const W = Math.min(1200, Math.max(900, sw - 80));
  const H = Math.min(800, Math.max(640, shh - 100));

  win = new BrowserWindow({
    width: W,
    height: H,
    x: Math.max(20, sw - W - 24),
    y: Math.max(20, Math.round((shh - H) / 2)),
    minWidth: 720,
    minHeight: 520,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,           // don't appear in Windows taskbar
    fullscreenable: false,
    title: 'Lumen',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // ── THE INVISIBILITY TRICK ───────────────────────────────────────────────
  // macOS: sets the window's sharingType to NSWindowSharingNone — excluded
  //        from screen recording, AirPlay mirroring, and most screen-share apps.
  // Windows: sets WDA_EXCLUDEFROMCAPTURE on the HWND (Win10 2004+).
  // Caveat: doesn't defend against a phone pointed at the screen, and a few
  // capture paths on older Windows builds may still see through it.
  win.setContentProtection(true);

  // Float above everything, including fullscreen apps (matches Cluely).
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  // getDisplayMedia handler. On macOS Sonoma+ we prefer the native picker;
  // we still provide a fallback that auto-picks the primary screen so the
  // renderer's getDisplayMedia() never silently fails.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        if (!sources.length) {
          // No sources = screen recording permission denied — open System Settings
          if (process.platform === 'darwin') {
            shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
          }
          return callback({});
        }
        const primaryScreen = sources.find(s => s.id.startsWith('screen:')) || sources[0];
        // Offer system-audio loopback alongside the video source. The renderer
        // decides whether it actually wants it: the screen-share path asks for
        // `audio: false` and still gets a video-only stream, while the Them
        // capture channel asks for `audio: true` and receives the loopback.
        // macOS needs the literal 'loopback' string; Windows takes a boolean.
        const grant = { video: primaryScreen, audio: false };
        if (process.platform === 'darwin') grant.audio = 'loopback';
        else if (process.platform === 'win32') grant.audio = true;
        callback(grant);
      } catch {
        if (process.platform === 'darwin') {
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        }
        callback({});
      }
    },
    { useSystemPicker: false }
  );

  win.loadURL('lumen://app/index.html');
  win.on('closed', () => { win = null; });

  // Route any window.open(http(s)) call to the user's default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });
}

function moveWindow(dx, dy) {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
}

function toggleVisible() {
  if (!win) return createWindow();
  if (win.isVisible() && win.isFocused()) win.hide();
  else { win.show(); win.focus(); }
}

function registerHotkeys() {
  const bindings = {
    'CommandOrControl+Shift+Space': toggleVisible,
    'CommandOrControl+Shift+L': () => {
      if (!win) createWindow();
      if (!win.isVisible()) win.show();
      win.focus();
      win.webContents.send('focus-input');
    },
    'CommandOrControl+Shift+T': () => {
      if (!win) return;
      clickThrough = !clickThrough;
      win.setIgnoreMouseEvents(clickThrough, { forward: true });
      win.webContents.send('click-through', clickThrough);
    },
    'CommandOrControl+Shift+Up':    () => moveWindow(0, -40),
    'CommandOrControl+Shift+Down':  () => moveWindow(0, 40),
    'CommandOrControl+Shift+Left':  () => moveWindow(-40, 0),
    'CommandOrControl+Shift+Right': () => moveWindow(40, 0),
    'CommandOrControl+Shift+O': () => { if (win) win.webContents.send('opacity-cycle'); },
  };
  const failed = [];
  for (const [k, fn] of Object.entries(bindings)) {
    if (!globalShortcut.register(k, fn)) failed.push(k);
  }
  if (failed.length) console.warn('[lumen] could not register:', failed.join(', '));
}

app.whenReady().then(() => {
  // Serve `lumen://app/<path>` from `renderer/<path>` so the renderer document
  // has a real, secure origin. `app` is the only allowed host; `..` segments
  // are rejected to prevent path traversal outside `renderer/`.
  protocol.handle('lumen', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    if (rel.includes('..')) return new Response('Forbidden', { status: 403 });
    const abs = path.join(__dirname, 'renderer', rel);
    return net.fetch(pathToFileURL(abs).toString());
  });

  // Check screen recording permission on startup and notify user if missing.
  // On macOS 10.15+, getMediaAccessStatus returns 'granted'/'denied'/'restricted'/'not-determined'.
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus) {
    const screenStatus = systemPreferences.getMediaAccessStatus('screen');
    console.log('[lumen] Screen recording permission:', screenStatus);
    if (screenStatus !== 'granted') {
      // We don't block startup — just log. The capture handler will open Settings if needed.
      console.log('[lumen] Screen recording not granted. User will be prompted on first capture.');
    }
  }

  createWindow();
  registerHotkeys();
});

app.on('activate', () => { if (!win) createWindow(); else { win.show(); win.focus(); } });
app.on('will-quit', () => globalShortcut.unregisterAll());
// Don't quit on window-all-closed — the global hotkey can resurrect the window.

ipcMain.on('lumen:quit',     () => app.quit());
ipcMain.on('lumen:hide',     () => win && win.hide());
ipcMain.on('lumen:show',     () => { if (win) { win.show(); win.focus(); } });
ipcMain.on('lumen:minimize', () => win && win.minimize());

ipcMain.on('lumen:set-opacity', (_evt, payload) => {
  const target = clampOpacity(payload && payload.level);
  const instant = !!(payload && payload.instant);
  if (opacityTweenTimer) { clearInterval(opacityTweenTimer); opacityTweenTimer = null; }
  if (instant || target === currentWindowOpacity) {
    if (win) win.setOpacity(target);
    currentWindowOpacity = target;
    return;
  }
  const start = currentWindowOpacity;
  const steps = 12;
  let i = 0;
  opacityTweenTimer = setInterval(() => {
    i += 1;
    const t = i / steps;
    const eased = 1 - Math.pow(1 - t, 3);
    const next = start + (target - start) * eased;
    if (win) win.setOpacity(next);
    if (i >= steps) {
      clearInterval(opacityTweenTimer);
      opacityTweenTimer = null;
      if (win) win.setOpacity(target);
      currentWindowOpacity = target;
    }
  }, 200 / 12);
});

ipcMain.on('lumen:open-perm-screen', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
});
ipcMain.on('lumen:open-perm-mic', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  }
});

// Permission status check — renderer can query this to show helpful UI
ipcMain.handle('lumen:check-screen-perm', () => {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus) {
    return systemPreferences.getMediaAccessStatus('screen');
  }
  return 'granted'; // non-macOS or old API
});

// LLM API proxy — routes fetch requests through the main process to bypass
// CORS restrictions that block requests from the lumen:// renderer origin.
ipcMain.handle('lumen:api-fetch', async (_evt, { url, method, headers, body }) => {
  try {
    const opts = {
      method: method || 'GET',
      headers: headers || {},
    };
    if (body !== undefined && body !== null) opts.body = body;
    const res = await net.fetch(url, opts);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: (e && e.message) || String(e) };
  }
});

// Direct screen capture for the one-shot screenshot path. Uses desktopCapturer
// with a thumbnail-sized request so we never invoke ScreenCaptureKit's
// SCContentSharingPicker. That picker has a known macOS bug (Collection
// mutated while being enumerated) that crashes the renderer on the second
// invocation. This path returns a base64 PNG of the entire primary display;
// the renderer crops in JS.
ipcMain.handle('lumen:capture-screen', async () => {
  try {
    const primary = screen.getPrimaryDisplay();
    const { width, height } = primary.size;
    const scale = primary.scaleFactor || 1;
    const maxLong = 1600;
    const longEdge = Math.max(width, height);
    const thumbScale = Math.min(1, maxLong / longEdge);
    const thumbW = Math.round(width * thumbScale * scale);
    const thumbH = Math.round(height * thumbScale * scale);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: thumbW, height: thumbH },
    });
    if (!sources.length) {
      if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      return { ok: false, error: 'no screen sources — screen recording permission needed' };
    }
    const src = sources.find(s => Number(s.display_id) === primary.id) || sources[0];
    if (!src.thumbnail || src.thumbnail.isEmpty()) return { ok: false, error: 'empty thumbnail' };
    return { ok: true, dataUrl: src.thumbnail.toDataURL() };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});
