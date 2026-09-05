// Standalone diagnostic for the system-audio (loopback) capture path.
//
// Run with `--audio-probe`. It opens a hidden window, attempts exactly what
// the Them channel attempts, measures whether the resulting track actually
// carries signal, and writes a JSON report to ~/lumen-audio-probe.json.
//
// It exists because the failure is invisible from the app: when Screen
// Recording is missing, getDisplayMedia still resolves with a track that
// carries pure silence, which is indistinguishable from nobody speaking.
// This reports each stage separately so the failing one is identifiable.

const { BrowserWindow, systemPreferences, desktopCapturer, session } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPORT = path.join(os.homedir(), 'lumen-audio-probe.json');


async function runProbe(app) {
  const report = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    macOS: os.release(),
    screenPermission: 'n/a',
    sources: null,
  };

  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus) {
    report.screenPermission = systemPreferences.getMediaAccessStatus('screen');
    report.micPermission = systemPreferences.getMediaAccessStatus('microphone');
  }

  try {
    const s = await desktopCapturer.getSources({ types: ['screen'] });
    report.sources = s.map((x) => x.id);
  } catch (e) {
    report.sources = 'error: ' + e.message;
  }

  // Same grant the app uses.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (!sources.length) return callback({});
      const grant = { video: sources[0], audio: false };
      if (process.platform === 'darwin') grant.audio = 'loopback';
      else if (process.platform === 'win32') grant.audio = true;
      callback(grant);
    } catch (e) { callback({}); }
  }, { useSystemPicker: false });

  const win = new BrowserWindow({
    width: 400, height: 300, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  // Poll the shared DOM for the result rather than awaiting a promise defined
  // in a different JS world.
  const done = (async () => {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const json = await win.webContents.executeJavaScript(
          `(() => { const e = document.getElementById('probe-out');
                    return e && e.getAttribute('data-done') ? e.textContent : null; })()`
        );
        if (json) return JSON.parse(json);
      } catch (_) { /* page still loading */ }
    }
    return { fatal: 'probe produced no result within 60s' };
  })();

  // Served over lumen:// so the page is a secure context and
  // navigator.mediaDevices actually exists.
  win.loadURL('lumen://app/probe.html');

  const page = await done;

  Object.assign(report, page);
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  try { win.destroy(); } catch (_) {}
  app.quit();
}

module.exports = { runProbe, REPORT };
