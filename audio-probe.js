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

// The page runs the capture itself; only a renderer can call getDisplayMedia.
const PAGE = `
<!doctype html><meta charset="utf-8"><body><script>
(async () => {
  const out = { stages: [] };
  const note = (stage, ok, detail) => out.stages.push({ stage, ok, detail });
  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      note('getDisplayMedia', true, 'resolved');
    } catch (e) {
      note('getDisplayMedia', false, String(e && e.message || e));
      return finish(out);
    }

    const audio = stream.getAudioTracks();
    const video = stream.getVideoTracks();
    note('audioTracks', audio.length > 0, 'count=' + audio.length + ' videoCount=' + video.length);
    if (!audio.length) return finish(out);

    const t = audio[0];
    note('trackState', t.readyState === 'live', 'label=' + JSON.stringify(t.label) +
      ' readyState=' + t.readyState + ' muted=' + t.muted + ' enabled=' + t.enabled);
    try { note('trackSettings', true, JSON.stringify(t.getSettings())); } catch (e) { note('trackSettings', false, String(e)); }

    // Measure real signal for 6s. Silence here with a live track is the exact
    // signature of the permission being missing.
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} }
    note('audioContext', ctx.state === 'running', 'state=' + ctx.state + ' sampleRate=' + ctx.sampleRate);
    const src = ctx.createMediaStreamSource(new MediaStream([t]));
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let peak = 0, samples = 0, nonZero = 0;
    await new Promise((res) => {
      const iv = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        samples++;
        if (rms > 0) nonZero++;
        if (rms > peak) peak = rms;
      }, 100);
      setTimeout(() => { clearInterval(iv); res(); }, 6000);
    });
    note('signal', peak > 0.0005, 'peakRMS=' + peak.toFixed(6) +
      ' nonZeroSamples=' + nonZero + '/' + samples);

    // And whether MediaRecorder — what the app actually records with — gets bytes.
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const rec = new MediaRecorder(new MediaStream([t]), mime ? { mimeType: mime } : {});
    const sizes = [];
    rec.ondataavailable = (e) => sizes.push(e.data ? e.data.size : 0);
    rec.start();
    await new Promise((r) => setTimeout(r, 3000));
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    note('mediaRecorder', sizes.some((s) => s > 1000), 'mime=' + (mime || 'default') + ' blobSizes=' + JSON.stringify(sizes));

    stream.getTracks().forEach((x) => x.stop());
  } catch (e) {
    out.fatal = String(e && e.stack || e);
  }
  finish(out);

  function finish(o) { window.__probeDone && window.__probeDone(JSON.stringify(o)); }
})();
</script></body>`;

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

  const done = new Promise((resolve) => {
    win.webContents.on('console-message', () => {});
    win.webContents.executeJavaScript('1').catch(() => {});
    win.webContents.once('did-finish-load', async () => {
      try {
        const json = await win.webContents.executeJavaScript(`
          new Promise((res) => { window.__probeDone = res; })
        `, true);
        resolve(JSON.parse(json));
      } catch (e) { resolve({ fatal: String(e) }); }
    });
  });

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));

  const page = await Promise.race([
    done,
    new Promise((r) => setTimeout(() => r({ fatal: 'probe timed out after 25s' }), 25000)),
  ]);

  Object.assign(report, page);
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  try { win.destroy(); } catch (_) {}
  app.quit();
}

module.exports = { runProbe, REPORT };
