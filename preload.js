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

  captureScreen: () => ipcRenderer.invoke('lumen:capture-screen'),

  onFocusInput:         (cb) => ipcRenderer.on('focus-input',  ()      => cb()),
  onClickThroughChange: (cb) => ipcRenderer.on('click-through', (_, v) => cb(v)),
  onOpacityCycle:       (cb) => ipcRenderer.on('opacity-cycle', ()     => cb()),
});
