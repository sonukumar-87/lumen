// Lumen — preload bridge.
// Exposes a tiny, locked-down `window.lumen` object to the renderer so it can:
//   • Trigger window controls (hide, minimize, quit)
//   • Open macOS permission panes directly
//   • Listen for events fired by global hotkeys (focus input, click-through)
//
// Everything else (LLM keys, screen capture, mic) lives in the renderer.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumen', {
  platform: process.platform,

  quit:     () => ipcRenderer.send('lumen:quit'),
  hide:     () => ipcRenderer.send('lumen:hide'),
  show:     () => ipcRenderer.send('lumen:show'),
  minimize: () => ipcRenderer.send('lumen:minimize'),

  openScreenPerms: () => ipcRenderer.send('lumen:open-perm-screen'),
  openMicPerms:    () => ipcRenderer.send('lumen:open-perm-mic'),

  setOpacity: (level, opts) => ipcRenderer.send('lumen:set-opacity', { level, instant: !!(opts && opts.instant) }),

  // Hands mouse events back to whatever is behind the window while the pointer
  // sits over a transparent gap. CSS pointer-events cannot do this on its own:
  // the OS window keeps swallowing the click either way.
  setIgnoreMouse: (ignore) => ipcRenderer.send('lumen:set-ignore-mouse', !!ignore),

  // The window must track the drawn UI exactly: anything it covers beyond that
  // is an invisible rectangle sitting over the screen.
  fitWindow: (width, height, collapse) =>
    ipcRenderer.send('lumen:fit-window', { width, height, collapse: !!collapse }),

  captureScreen: () => ipcRenderer.invoke('lumen:capture-screen'),
  checkScreenPerm: () => ipcRenderer.invoke('lumen:check-screen-perm'),

  // Proxy LLM API fetch calls through the main process to bypass CORS
  apiFetch: (url, method, headers, body) =>
    ipcRenderer.invoke('lumen:api-fetch', { url, method, headers, body }),

  onFocusInput:         (cb) => ipcRenderer.on('focus-input',  ()      => cb()),
  onClickThroughChange: (cb) => ipcRenderer.on('click-through', (_, v) => cb(v)),
  onOpacityCycle:       (cb) => ipcRenderer.on('opacity-cycle', ()     => cb()),
  onTranscriptAction:   (cb) => ipcRenderer.on('transcript-action', (_, a) => cb(a)),
});
