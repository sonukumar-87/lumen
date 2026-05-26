// Lumen — renderer.
// All chat backend logic, screen capture, and mic transcription live here.
// `window.lumen` (from preload) is available in Electron; in a plain browser
// we fall back to no-ops so the same file still works.

const L = window.lumen || {
  platform: 'browser',
  quit() {}, hide() {}, minimize() {}, show() {},
  openScreenPerms() {}, openMicPerms() {},
  setOpacity() {},
  captureScreen() { return Promise.resolve({ ok: false, error: 'browser' }); },
  onFocusInput() {}, onClickThroughChange() {}, onOpacityCycle() {},
};

// New layout needs more room — request resize via IPC if available, otherwise
// rely on user resize. main.js is not modified in this pass; the user can
// drag the corner to widen. Compact mode (≤700px) keeps the layout usable
// at the default 460×720 window size.

// ── DOM refs ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// Chat / input
const chat = $('chat'), input = $('input'), sendBtn = $('send'), clearBtn = $('clear');
// Status / activity badges
const statusEl = $('status'), eyeEl = $('eye'), earEl = $('ear');
// Backend settings (now inside the Settings pane, sidebar drives the select)
const backendSel = $('backend'), modelInput = $('model'), modelHint = $('model-hint');
const apikeyInput = $('apikey'), savekeyBtn = $('savekey'), clearkeyBtn = $('clearkey');
const ollamaUrlInput = $('ollamaurl'), pingBtn = $('ping');
const keyRow = $('key-row'), keyLabel = $('key-label'), ollamaRow = $('ollama-row');
// Screen capture (share = "Full Screen" item in right bar; share-input = pill in input bar)
const shareBtn = $('share'), shareInputBtn = $('share-input');
const snapInputBtn = $('snap-input');
const micInputBtn = $('mic-input');
const previewWrap = $('preview-wrap'), previewVideo = $('preview-video'),
      previewBackend = $('preview-backend');
const lastCaptureMeta = $('last-capture-meta');
const previewStill = $('preview-still');

function showStillPreview(dataUrl) {
  if (!previewStill || !previewWrap || !previewVideo) return;
  previewStill.src = dataUrl;
  previewStill.hidden = false;
  previewVideo.hidden = true;
  previewWrap.hidden = false;
  previewWrap.classList.remove('rb-thumb-empty');
}
function hideStillPreview() {
  if (previewStill) { previewStill.hidden = true; previewStill.src = ''; }
}
// Mic transcription
const listenBtn = $('listen'), listenLabel = $('listen-label');
const transcriptWrap = $('transcript-wrap'), transcriptText = $('transcript-text'),
      transcriptLang = $('transcript-lang'), transcriptUse = $('transcript-use'),
      transcriptAppend = $('transcript-append'), transcriptClear = $('transcript-clear');
// Window controls
const btnMin = $('btn-min'), btnClose = $('btn-close'), ctBadge = $('ct-badge');
const opacityBadge = $('opacity-badge');
const opacitySlider = $('opacity');
const hotkeysBtn = $('hotkeys-btn');
const hotkeysModal = $('hotkeys-modal');
const hotkeysClose = $('hotkeys-close');
const attachBtn = $('attach-btn');
const attachInput = $('attach-input');
// Backwards-compat alias for code that references opacityBtn.
const opacityBtn = opacitySlider;
// New layout extras
const greetingEl = $('greeting');
const lcPill = $('lc-pill');
const aiDot = $('ai-dot'), aiStatusText = $('ai-status-text');
const sbAi = $('sb-ai'), sbContext = $('sb-context'), sbOcr = $('sb-ocr'),
      sbPrivacy = $('sb-privacy'), sbAot = $('sb-aot');
const recentList = $('rb-recent');

// ── State ───────────────────────────────────────────────────────────────────
let history = [];                 // text-only conversation history (images & audio are per-turn)
let screenStream = null;          // active MediaStream when screen-sharing
let prevTextModel = null;         // remember text model so we can restore on stop
let listening = false;
let finalTranscript = '';
let interimTranscript = '';
let lastCheckOk = false;          // result of the most recent check()
let alwaysOnTop = true;           // visual toggle only — main.js sets the real flag

// ── Opacity_Controller (1..100 slider) ───────────────────────────────────────
const OPACITY_KEY = 'lumen.opacity';
let currentOpacity = 100;

function loadOpacity() {
  const raw = localStorage.getItem(OPACITY_KEY);
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 20 && n <= 100) return Math.round(n);
  localStorage.setItem(OPACITY_KEY, '100');
  return 100;
}

function setOpacity(level) {
  const n = Math.max(20, Math.min(100, Math.round(Number(level))));
  if (!Number.isFinite(n)) return;
  currentOpacity = n;
  localStorage.setItem(OPACITY_KEY, String(n));
  updateOpacityBadge();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  L.setOpacity(n, { instant: reduced });
}

// Hotkey-triggered cycle still does the discrete 100→70→40 walk for muscle memory.
function cycleOpacity() {
  const cycle = [100, 70, 40];
  let i = 0, bestDiff = Infinity;
  for (let k = 0; k < cycle.length; k++) {
    const d = Math.abs(cycle[k] - currentOpacity);
    if (d < bestDiff) { bestDiff = d; i = k; }
  }
  const next = cycle[(i + 1) % cycle.length];
  setOpacity(next);
  if (opacitySlider) opacitySlider.value = String(next);
}

function updateOpacityBadge() {
  if (opacityBadge) opacityBadge.textContent = currentOpacity + '%';
  if (opacitySlider && Number(opacitySlider.value) !== currentOpacity) {
    opacitySlider.value = String(currentOpacity);
  }
}

// ── Whisper_Client state ────────────────────────────────────────────────────
let mediaStream = null;
let mediaRecorder = null;
let chunkSeq = 0;
let nextAppendSeq = 0;
const pendingTranscripts = new Map();
let inFlight = 0;
let stopped = false;
let chunkRotateTimer = null;
let errored = false;

// ── Model defaults & vision swaps ───────────────────────────────────────────
const TEXT_DEFAULTS   = { groq: 'llama-3.3-70b-versatile', gemini: 'gemini-2.0-flash-lite', ollama: 'llama3.2' };
const VISION_DEFAULTS = { groq: 'meta-llama/llama-4-scout-17b-16e-instruct', gemini: 'gemini-2.0-flash', ollama: 'llava' };
const VISION_HINTS = {
  groq:   'vision: llama-4-scout / llama-4-maverick',
  gemini: 'vision: gemini-2.0-flash, gemini-2.5-pro',
  ollama: 'vision: llava, llama3.2-vision, bakllava',
};

// ── Key storage ─────────────────────────────────────────────────────────────
const keyName = () => 'lumen.key.' + backendSel.value;
const LS_BACKEND = 'lumen.backend';
const LS_MODEL_PREFIX = 'lumen.model.';

backendSel.value = localStorage.getItem(LS_BACKEND) || 'groq';
modelInput.value = localStorage.getItem(LS_MODEL_PREFIX + backendSel.value) || TEXT_DEFAULTS[backendSel.value] || '';
apikeyInput.value = localStorage.getItem(keyName()) || '';
syncRows();
updateLcPill();

function syncRows() {
  keyRow.hidden = (backendSel.value === 'echo' || backendSel.value === 'ollama');
  ollamaRow.hidden = backendSel.value !== 'ollama';
  keyLabel.textContent = backendSel.value === 'groq'   ? 'Groq API key (starts with gsk_…)'
                      :  backendSel.value === 'gemini' ? 'Gemini API key (starts with AIza…)'
                      :  'API key';
  apikeyInput.placeholder = backendSel.value === 'groq' ? 'gsk_…' : backendSel.value === 'gemini' ? 'AIza…' : '';
  modelHint.textContent = VISION_HINTS[backendSel.value] ? '— ' + VISION_HINTS[backendSel.value] : '';
  if (previewBackend) previewBackend.textContent = backendSel.value;
}

function updateLcPill() {
  const isLocal = backendSel.value === 'ollama' || backendSel.value === 'echo';
  if (lcPill) {
    lcPill.textContent = isLocal ? 'LOCAL' : 'CLOUD';
    lcPill.classList.toggle('cloud', !isLocal);
  }
  // Also update bottom-bar privacy classification.
  if (sbPrivacy) {
    sbPrivacy.textContent = isLocal ? '🔒 Privacy: Local Only' : '🔒 Privacy: BYOK';
  }
}

backendSel.addEventListener('change', () => {
  localStorage.setItem(LS_BACKEND, backendSel.value);
  modelInput.value = localStorage.getItem(LS_MODEL_PREFIX + backendSel.value) || TEXT_DEFAULTS[backendSel.value] || '';
  apikeyInput.value = localStorage.getItem(keyName()) || '';
  prevTextModel = null;
  syncRows();
  updateLcPill();
  check();
});
modelInput.addEventListener('change', () => localStorage.setItem(LS_MODEL_PREFIX + backendSel.value, modelInput.value));
savekeyBtn.addEventListener('click',  () => { localStorage.setItem(keyName(), apikeyInput.value.trim()); setStatus('key saved', true); check(); });
clearkeyBtn.addEventListener('click', () => { localStorage.removeItem(keyName()); apikeyInput.value=''; setStatus('key cleared', false); });

// ── UI helpers ──────────────────────────────────────────────────────────────
function nowTimeShort() {
  const d = new Date();
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + m + ' ' + ampm;
}

function relativeTime(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) {
    const d = new Date(ts);
    let h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + m + ' ' + ampm;
  }
  if (diff < 86400 * 2) return 'Yest';
  return Math.floor(diff / 86400) + 'd';
}

function addMsg(role, text) {
  const row = document.createElement('div');
  row.className = 'msg-row ' + role;

  if (role === 'assistant') {
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = '🤖';
    row.appendChild(av);
  }

  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.maxWidth = '100%';
  wrap.style.minWidth = '0';

  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.textContent = text;
  wrap.appendChild(d);

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  if (role === 'assistant') {
    meta.innerHTML = '<span class="msg-actions"><span title="Copy">⎘</span><span title="Helpful">👍</span><span title="Not helpful">👎</span></span>';
    const ts = document.createElement('span');
    ts.style.marginLeft = 'auto';
    ts.textContent = nowTimeShort();
    meta.appendChild(ts);
  } else {
    const ts = document.createElement('span');
    ts.textContent = nowTimeShort() + ' ✓';
    meta.appendChild(ts);
  }
  wrap.appendChild(meta);

  row.appendChild(wrap);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;

  if (role === 'user') pushRecentHistory(text);
  return d;
}

function addAssistantPlaceholder() {
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = '🤖';
  row.appendChild(av);

  const d = document.createElement('div');
  d.className = 'msg assistant';
  const t = document.createElement('span');
  t.className = 'typing';
  t.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  d.appendChild(t);
  row.appendChild(d);

  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
  return d;
}

function attachThumb(parent, dataUrl) {
  const img = document.createElement('img');
  img.className = 'thumb'; img.src = dataUrl;
  parent.appendChild(img);
  chat.scrollTop = chat.scrollHeight;
}

function setStatus(s, ok) {
  statusEl.textContent = s;
  statusEl.style.color = ok ? 'var(--ok)' : 'var(--muted)';
  if (transcriptText) transcriptText.classList.toggle('shimmer', s === 'transcribing…');
  lastCheckOk = !!ok;
  updateAiModelStatus(s, ok);
  updateAiStatusBar();
}

function updateAiModelStatus(text, ok) {
  if (!aiDot || !aiStatusText) return;
  aiDot.classList.remove('ok', 'warn', 'err');
  if (backendSel.value === 'echo') {
    aiDot.classList.add('ok');
    aiStatusText.textContent = 'Status: Echo mode';
    return;
  }
  if (ok) {
    aiDot.classList.add('ok');
    aiStatusText.textContent = backendSel.value === 'ollama' ? 'Status: Running' : 'Status: Connected';
  } else {
    aiDot.classList.add('warn');
    // Trim to a short label; keep tooltip with full message.
    const short = (text || '').replace(/\s*\(.*$/, '').slice(0, 36);
    aiStatusText.textContent = 'Status: ' + (short || 'Disconnected');
    aiStatusText.title = text || '';
  }
}

function updateAiStatusBar() {
  if (!sbAi) return;
  sbAi.classList.remove('ok', 'warn', 'err');
  if (backendSel.value === 'echo') {
    sbAi.textContent = 'Local AI (Echo)';
    sbAi.classList.add('ok');
    return;
  }
  if (backendSel.value === 'ollama') {
    if (lastCheckOk) { sbAi.textContent = 'Local AI Running'; sbAi.classList.add('ok'); }
    else             { sbAi.textContent = 'Local AI Disconnected'; sbAi.classList.add('warn'); }
    return;
  }
  if (lastCheckOk) { sbAi.textContent = 'Cloud AI Connected'; sbAi.classList.add('ok'); }
  else             { sbAi.textContent = 'Cloud AI Disconnected'; sbAi.classList.add('warn'); }
}

function currentKey() { return apikeyInput.value.trim() || localStorage.getItem(keyName()) || ''; }

// ── Greeting ────────────────────────────────────────────────────────────────
function greetingFor(hour) {
  if (hour >= 5 && hour < 12) return 'Good morning, User.';
  if (hour >= 12 && hour < 18) return 'Good afternoon, User.';
  return 'Good evening, User.';
}
if (greetingEl) greetingEl.textContent = greetingFor(new Date().getHours());

// ── Window controls ─────────────────────────────────────────────────────────
btnMin.addEventListener('click',   () => L.minimize());
btnClose.addEventListener('click', () => L.hide());
L.onFocusInput(() => input.focus());
L.onClickThroughChange((v) => { ctBadge.hidden = !v; });

// Opacity controller boot — load persisted level, apply instantly on first paint.
currentOpacity = loadOpacity();
updateOpacityBadge();
if (opacitySlider) opacitySlider.value = String(currentOpacity);
L.setOpacity(currentOpacity, { instant: true });

if (opacitySlider) {
  opacitySlider.addEventListener('input', () => setOpacity(opacitySlider.value));
}
L.onOpacityCycle(cycleOpacity);

// Hotkeys modal
function openHotkeys() { if (hotkeysModal) hotkeysModal.hidden = false; }
function closeHotkeys() { if (hotkeysModal) hotkeysModal.hidden = true; }
if (hotkeysBtn) hotkeysBtn.addEventListener('click', openHotkeys);
if (hotkeysClose) hotkeysClose.addEventListener('click', closeHotkeys);
if (hotkeysModal) hotkeysModal.addEventListener('click', (e) => {
  if (e.target === hotkeysModal) closeHotkeys();
});

// Attach pill — opens a hidden file picker, reads as data URL, becomes pendingSnap.
if (attachBtn && attachInput) {
  attachBtn.addEventListener('click', () => attachInput.click());
  attachInput.addEventListener('change', () => {
    const file = attachInput.files && attachInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      pendingSnap = reader.result;
      setStatus('image attached — ask a question about it', true);
      input.focus();
    };
    reader.onerror = () => setStatus('attach failed', false);
    reader.readAsDataURL(file);
    // Reset input so picking the same file twice still fires `change`.
    attachInput.value = '';
  });
}

// ── Sidebar nav state machine ───────────────────────────────────────────────
const navItems = document.querySelectorAll('.nav-item[data-pane]');
const PANES = ['chat', 'ask-screen', 'listen', 'quick', 'notes', 'history', 'settings'];

function showPane(name) {
  for (const p of PANES) {
    const el = document.getElementById('pane-' + p);
    if (el) el.hidden = (p !== name);
  }
  navItems.forEach(it => it.classList.toggle('active', it.dataset.pane === name));
}

navItems.forEach(it => {
  it.addEventListener('click', () => {
    const pane = it.dataset.pane;
    showPane(pane);
    if (pane === 'ask-screen') {
      // For now: route to existing toggleScreen() and surface a note.
      // Region capture is a future spec.
      if (!screenStream) toggleScreen();
      setStatus('Coming soon: drag-to-select region capture', false);
    }
    if (pane === 'listen') {
      // Toggle listening as well so the Listen sidebar item behaves like a mic switch.
      toggleListen();
    }
  });
});
showPane('chat');

// ── Suggestion cards (chat pane + quick actions pane) ──────────────────────
const SUGGESTION_PROMPTS = {
  summarize: 'Summarize the following:\n\n',
  explain:   'Explain this in simple terms:\n\n',
  translate: '__translate__',
  improve:   'Improve the wording and clarity of:\n\n',
};

function buildTranslatePrompt(content) {
  const stored = localStorage.getItem('lumen.translateLang');
  const ask = stored && stored.trim() ? stored.trim() : (window.prompt('Translate to which language?', 'French') || '').trim();
  if (!ask) return null;
  if (!stored) localStorage.setItem('lumen.translateLang', ask);
  return 'Translate the following to ' + ask + ':\n\n' + content;
}

document.querySelectorAll('.sugg').forEach(card => {
  card.addEventListener('click', () => {
    const action = card.dataset.action;
    const tmpl = SUGGESTION_PROMPTS[action];
    if (!tmpl) return;
    showPane('chat');
    const existing = input.value.trim();
    if (action === 'translate') {
      // Translate is special: prompt for the target language once, then auto-send
      // if there's existing text, otherwise prefill the input.
      if (existing.length > 0) {
        const built = buildTranslatePrompt(existing);
        if (built) { input.value = built; ask(); }
      } else {
        const lang = localStorage.getItem('lumen.translateLang') || (window.prompt('Translate to which language?', 'French') || '').trim();
        if (!lang) return;
        localStorage.setItem('lumen.translateLang', lang);
        input.value = 'Translate the following to ' + lang + ':\n\n';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
      return;
    }
    if (existing.length > 0) {
      input.value = tmpl + existing;
      ask();
    } else {
      input.value = tmpl;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
});

// ── Recent history sidebar ─────────────────────────────────────────────────
const RECENT_MAX = 4;
const recent = []; // { text, ts }

function pushRecentHistory(text) {
  recent.unshift({ text, ts: Date.now() });
  while (recent.length > RECENT_MAX) recent.pop();
  renderRecent();
}

function renderRecent() {
  if (!recentList) return;
  if (recent.length === 0) {
    recentList.innerHTML = '<div class="empty-line">No recent prompts yet</div>';
    return;
  }
  recentList.innerHTML = '';
  recent.forEach(r => {
    const row = document.createElement('div');
    row.className = 'row';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = r.text;
    t.title = r.text;
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = relativeTime(r.ts);
    row.appendChild(t); row.appendChild(ts);
    recentList.appendChild(row);
  });
}
// Refresh the relative timestamps periodically.
setInterval(renderRecent, 60_000);

// ── Always-on-top toggle (visual only) ─────────────────────────────────────
// TODO: wire this through an IPC handler in main.js to actually flip
// BrowserWindow.setAlwaysOnTop(value, 'screen-saver'). main.js is intentionally
// unmodified in this UI pass, so this toggle currently only updates the pill.
if (sbAot) {
  sbAot.classList.toggle('on', alwaysOnTop);
  sbAot.addEventListener('click', () => {
    alwaysOnTop = !alwaysOnTop;
    sbAot.classList.toggle('on', alwaysOnTop);
    // No IPC call: the real flag stays whatever main.js set at boot.
  });
}

// ── Bottom status bar — static items ───────────────────────────────────────
if (sbContext) sbContext.textContent = 'Context Memory On';
if (sbOcr) sbOcr.textContent = 'Screen OCR Ready';

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN CAPTURE
// ─────────────────────────────────────────────────────────────────────────────
shareBtn.addEventListener('click', toggleScreen);
if (shareInputBtn) shareInputBtn.addEventListener('click', toggleScreen);

// One-shot screenshot pill: grab a single frame, attach to the next prompt,
// then close the stream so the macOS sharing icon goes away.
let pendingSnap = null;

// Crop overlay — shown after a screenshot to let the user drag a rectangle.
function openCropOverlay(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.55);' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'cursor:crosshair;user-select:none;-webkit-user-select:none;';

      const hint = document.createElement('div');
      hint.style.cssText =
        'position:absolute;top:14px;left:50%;transform:translateX(-50%);' +
        'background:rgba(0,0,0,0.65);color:#fff;padding:6px 12px;border-radius:8px;' +
        'font:12px -apple-system,system-ui,sans-serif;pointer-events:none;';
      hint.textContent = 'Drag to crop  ·  Enter to use full image  ·  Esc to cancel';
      overlay.appendChild(hint);

      const wrap = document.createElement('div');
      wrap.style.cssText =
        'position:relative;max-width:92vw;max-height:82vh;display:inline-block;';
      const dispImg = document.createElement('img');
      dispImg.src = dataUrl;
      dispImg.style.cssText = 'max-width:92vw;max-height:82vh;display:block;border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,0.6);';
      wrap.appendChild(dispImg);

      const sel = document.createElement('div');
      sel.style.cssText =
        'position:absolute;border:1.5px dashed #7aa2ff;background:rgba(122,162,255,0.12);' +
        'pointer-events:none;display:none;';
      wrap.appendChild(sel);
      overlay.appendChild(wrap);

      let startX = 0, startY = 0, dragging = false, hasSel = false;
      let curBox = null; // {x,y,w,h} in display-pixel coords relative to wrap

      function rectFromPoints(ax, ay, bx, by) {
        const x = Math.min(ax, bx), y = Math.min(ay, by);
        const w = Math.abs(bx - ax), h = Math.abs(by - ay);
        return { x, y, w, h };
      }

      function onDown(e) {
        if (e.target.closest('.crop-actions')) return;
        e.preventDefault();
        const rect = dispImg.getBoundingClientRect();
        startX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        startY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
        dragging = true;
        sel.style.display = 'block';
        sel.style.left = startX + 'px';
        sel.style.top = startY + 'px';
        sel.style.width = '0px';
        sel.style.height = '0px';
      }
      function onMove(e) {
        if (!dragging) return;
        const rect = dispImg.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
        const r = rectFromPoints(startX, startY, x, y);
        sel.style.left = r.x + 'px';
        sel.style.top = r.y + 'px';
        sel.style.width = r.w + 'px';
        sel.style.height = r.h + 'px';
        curBox = r;
      }
      function onUp() {
        if (!dragging) return;
        dragging = false;
        if (curBox && curBox.w > 5 && curBox.h > 5) hasSel = true;
        else { sel.style.display = 'none'; hasSel = false; }
      }

      function finalize(useCrop) {
        // CAPTURE rect BEFORE removing the overlay — otherwise the image
        // detaches and getBoundingClientRect() returns 0×0, which breaks
        // the crop math and produces a malformed data URL.
        const dispRect = dispImg.getBoundingClientRect();
        cleanup();
        if (!useCrop || !hasSel) {
          // Re-encode the full image through a canvas → clean JPEG data URL.
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          pendingSnap = c.toDataURL('image/jpeg', 0.85);
          setStatus('screenshot attached — ask a question about it', true);
          if (lastCaptureMeta) lastCaptureMeta.textContent = 'Snapshot · ' + nowTimeShort();
          showStillPreview(pendingSnap);
          input.focus();
          resolve();
          return;
        }
        // Map display-pixel selection back to source image pixels.
        const scaleX = img.naturalWidth / dispRect.width;
        const scaleY = img.naturalHeight / dispRect.height;
        const sx = Math.max(0, Math.round(curBox.x * scaleX));
        const sy = Math.max(0, Math.round(curBox.y * scaleY));
        const sw = Math.max(1, Math.round(curBox.w * scaleX));
        const sh = Math.max(1, Math.round(curBox.h * scaleY));
        // Clamp to image bounds.
        const cw = Math.min(sw, img.naturalWidth - sx);
        const ch = Math.min(sh, img.naturalHeight - sy);
        if (cw < 4 || ch < 4 || !isFinite(cw) || !isFinite(ch)) {
          // Crop ended up empty — fall back to full image.
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          pendingSnap = c.toDataURL('image/jpeg', 0.85);
          setStatus('crop too small — used full image instead', true);
          showStillPreview(pendingSnap);
          input.focus();
          resolve();
          return;
        }
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch);
        pendingSnap = c.toDataURL('image/jpeg', 0.85);
        setStatus('cropped screenshot attached — ask a question about it', true);
        if (lastCaptureMeta) lastCaptureMeta.textContent = 'Crop · ' + nowTimeShort();
        showStillPreview(pendingSnap);
        input.focus();
        resolve();
      }

      function cancel() {
        cleanup();
        setStatus('screenshot canceled', false);
        resolve();
      }

      function cleanup() {
        document.removeEventListener('keydown', onKey);
        try { overlay.remove(); } catch (_) {}
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        else if (e.key === 'Enter') { e.preventDefault(); finalize(true); }
      }

      // Action bar (Use crop / Use full / Cancel)
      const actions = document.createElement('div');
      actions.className = 'crop-actions';
      actions.style.cssText =
        'position:absolute;bottom:14px;left:50%;transform:translateX(-50%);' +
        'display:flex;gap:8px;background:rgba(0,0,0,0.55);padding:6px;border-radius:10px;';
      function mkBtn(label, fn, primary) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText =
          'padding:6px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);' +
          'background:' + (primary ? '#7aa2ff' : 'rgba(255,255,255,0.06)') + ';' +
          'color:' + (primary ? '#0b0d12' : '#fff') + ';' +
          'font:12px -apple-system,system-ui,sans-serif;cursor:pointer;';
        b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
        return b;
      }
      actions.appendChild(mkBtn('Use crop', () => finalize(true), true));
      actions.appendChild(mkBtn('Use full image', () => { hasSel = false; finalize(false); }));
      actions.appendChild(mkBtn('Cancel', cancel));
      overlay.appendChild(actions);

      wrap.addEventListener('mousedown', onDown);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.addEventListener('keydown', onKey);

      document.body.appendChild(overlay);
    };
    img.onerror = () => { resolve(); };
    img.src = dataUrl;
  });
}

if (snapInputBtn) {
  snapInputBtn.addEventListener('click', async () => {
    // If a continuous share is already running, just grab from that — no IPC needed.
    if (screenStream) {
      const frame = captureFrame();
      if (frame) {
        await openCropOverlay(frame);
      } else {
        setStatus('share is starting up — try again in a moment', false);
      }
      return;
    }
    snapInputBtn.classList.add('active');
    try {
      // Hide Lumen briefly so it isn't in the captured frame, then ask main
      // to grab the screen via desktopCapturer (no system picker, no crash).
      // setContentProtection already excludes us, but hiding adds belt+suspenders.
      try { L.hide(); } catch (_) {}
      // Give the compositor one frame to actually hide the window.
      await new Promise(r => setTimeout(r, 120));
      const result = await L.captureScreen();
      // Bring Lumen back regardless of result.
      try { L.show && L.show(); } catch (_) {}
      if (!result || !result.ok) {
        setStatus('screenshot failed: ' + (result && result.error ? result.error : 'unknown'), false);
        return;
      }
      await openCropOverlay(result.dataUrl);
    } catch (e) {
      setStatus('screenshot failed: ' + (e && e.message ? e.message : 'error'), false);
    } finally {
      snapInputBtn.classList.remove('active');
    }
  });
}

// Mic pill in the input bar — same as the sidebar Listen item.
if (micInputBtn) {
  micInputBtn.addEventListener('click', () => toggleListen());
}

async function toggleScreen() {
  if (screenStream) { stopScreen(); return; }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false });
    previewVideo.srcObject = screenStream;
    await previewVideo.play();
    previewVideo.hidden = false;
    hideStillPreview();
    previewWrap.hidden = false;
    previewWrap.classList.remove('rb-thumb-empty');
    if (lastCaptureMeta) lastCaptureMeta.textContent = 'Live · ' + nowTimeShort();
    shareBtn.classList.add('active');
    if (shareInputBtn) shareInputBtn.classList.add('active');
    eyeEl.textContent = '👁 on';
    screenStream.getVideoTracks()[0].addEventListener('ended', stopScreen);

    const vd = VISION_DEFAULTS[backendSel.value];
    if (vd && modelInput.value !== vd) {
      prevTextModel = modelInput.value;
      modelInput.value = vd;
      localStorage.setItem(LS_MODEL_PREFIX + backendSel.value, vd);
      setStatus('sharing — switched to ' + vd, true);
    } else {
      setStatus('sharing — fresh frame each Ask', true);
    }
  } catch (e) {
    setStatus('screen share denied: ' + e.message, false);
    if (L.platform === 'darwin' && /not allowed|denied|permission/i.test(e.message)) {
      addMsg('assistant', 'macOS needs Screen Recording permission for Lumen.\nOpening System Settings → Privacy & Security → Screen Recording.\nEnable Lumen there, then quit and relaunch.');
      L.openScreenPerms();
    }
  }
}
function stopScreen() {
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  previewVideo.srcObject = null;
  previewWrap.hidden = true;
  shareBtn.classList.remove('active');
  if (shareInputBtn) shareInputBtn.classList.remove('active');
  eyeEl.textContent = '👁 off';
  if (lastCaptureMeta) lastCaptureMeta.textContent = 'Last share · ' + nowTimeShort();
  if (prevTextModel) {
    modelInput.value = prevTextModel;
    localStorage.setItem(LS_MODEL_PREFIX + backendSel.value, prevTextModel);
    prevTextModel = null;
  }
  setStatus('screen share stopped', false);
}
function captureFrame() {
  if (!screenStream || !previewVideo.videoWidth) return null;
  const maxW = 1280;
  const scale = Math.min(1, maxW / previewVideo.videoWidth);
  const c = document.createElement('canvas');
  c.width  = Math.round(previewVideo.videoWidth  * scale);
  c.height = Math.round(previewVideo.videoHeight * scale);
  c.getContext('2d').drawImage(previewVideo, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

// ─────────────────────────────────────────────────────────────────────────────
// WHISPER CONFIG READERS
// ─────────────────────────────────────────────────────────────────────────────
function readWhisperEndpoint() {
  const raw = localStorage.getItem('lumen.whisper.endpoint');
  if (raw == null || raw === '') return 'https://api.groq.com/openai/v1/audio/transcriptions';
  return raw;
}
function readWhisperModel() {
  const raw = localStorage.getItem('lumen.whisper.model');
  if (raw == null || raw === '') return 'whisper-large-v3';
  return raw;
}
function readChunkSeconds() {
  const raw = localStorage.getItem('lumen.whisper.chunkSeconds');
  if (raw == null || raw === '') return 5;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 5;
  if (!Number.isInteger(n)) return 5;
  if (n < 1 || n > 30) return 5;
  return n;
}
function readGroqKey() {
  const raw = localStorage.getItem('lumen.key.groq');
  return raw == null ? '' : String(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// WHISPER MIME PICK
// ─────────────────────────────────────────────────────────────────────────────
const WHISPER_DEFAULT_MIME = 'audio/webm;codecs=opus';

function extFromMime(mime) {
  if (!mime) return 'bin';
  if (/^audio\/webm/.test(mime)) return 'webm';
  if (/^audio\/ogg/.test(mime)) return 'ogg';
  if (/^audio\/mp4/.test(mime)) return 'mp4';
  return 'bin';
}

function pickRecorderMime() {
  const SR = (typeof MediaRecorder !== 'undefined') ? MediaRecorder : null;
  const supported = SR && typeof SR.isTypeSupported === 'function'
    ? SR.isTypeSupported(WHISPER_DEFAULT_MIME)
    : false;
  if (supported) {
    return { mimeType: WHISPER_DEFAULT_MIME, contentType: WHISPER_DEFAULT_MIME, filenameExt: 'webm' };
  }
  return { mimeType: undefined, contentType: undefined, filenameExt: undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// WHISPER LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────
let recorderOpts = null;

function onDataAvailable(e) { enqueueChunk(e.data); }

async function startWhisper() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    reportError('mic-denied', e);
    return;
  }
  mediaStream = stream;

  chunkSeq = 0;
  nextAppendSeq = 0;
  pendingTranscripts.clear();
  inFlight = 0;
  stopped = false;
  errored = false;

  const pick = pickRecorderMime();
  recorderOpts = pick.mimeType ? { mimeType: pick.mimeType } : {};

  mediaRecorder = new MediaRecorder(mediaStream, recorderOpts);
  mediaRecorder.ondataavailable = onDataAvailable;
  mediaRecorder.start();

  chunkRotateTimer = setInterval(rotateRecorder, readChunkSeconds() * 1000);

  listening = true;
  updateListenUI();
  setStatus('listening…', true);
}

function rotateRecorder() {
  if (!listening || errored) return;
  try { mediaRecorder.stop(); } catch (e) { /* ignore */ }
  mediaRecorder = new MediaRecorder(mediaStream, recorderOpts);
  mediaRecorder.ondataavailable = onDataAvailable;
  mediaRecorder.start();
}

function stopWhisper() {
  stopped = true;
  if (chunkRotateTimer) {
    clearInterval(chunkRotateTimer);
    chunkRotateTimer = null;
  }
  try { mediaRecorder && mediaRecorder.stop(); } catch (e) { /* ignore */ }
  if (mediaStream) {
    try { mediaStream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
  }
  listening = false;
  updateListenUI();
  updateStatusLine();
}

// ─────────────────────────────────────────────────────────────────────────────
// WHISPER CHUNK PIPELINE
// ─────────────────────────────────────────────────────────────────────────────
function enqueueChunk(blob) {
  if (!blob || blob.size === 0) return;
  const seq = chunkSeq++;
  inFlight += 1;
  updateStatusLine();
  postChunk(seq, blob);
}

async function postChunk(seq, blob) {
  const form = new FormData();
  const ext = extFromMime(blob.type);
  form.append('file', blob, 'chunk-' + seq + '.' + ext);
  form.append('model', readWhisperModel());
  form.append('response_format', 'json');

  let res;
  try {
    res = await fetch(readWhisperEndpoint(), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + readGroqKey() },
      body: form,
    });
  } catch (e) {
    inFlight = Math.max(0, inFlight - 1);
    updateStatusLine();
    if (!errored) reportError('fetch-network-error', e);
    return;
  }

  if (!res.ok) {
    inFlight = Math.max(0, inFlight - 1);
    updateStatusLine();
    if (errored) return;
    let bodyText = '';
    try { bodyText = await res.text(); } catch (_) { bodyText = ''; }
    reportError('http-non-2xx', { status: res.status, body: bodyText.slice(0, 300) });
    return;
  }

  let parsed;
  try {
    parsed = await res.json();
  } catch (e) {
    inFlight = Math.max(0, inFlight - 1);
    updateStatusLine();
    if (!errored) reportError('malformed-json', e);
    return;
  }

  if (parsed == null || typeof parsed !== 'object' || typeof parsed.text !== 'string') {
    inFlight = Math.max(0, inFlight - 1);
    updateStatusLine();
    if (!errored) reportError('malformed-json', { reason: 'no-text-field' });
    return;
  }

  if (!errored) {
    pendingTranscripts.set(seq, { ok: true, text: String(parsed.text).trim() });
    drainAppendQueue();
  }
  inFlight = Math.max(0, inFlight - 1);
  updateStatusLine();
}

function drainAppendQueue() {
  while (pendingTranscripts.has(nextAppendSeq)) {
    const entry = pendingTranscripts.get(nextAppendSeq);
    pendingTranscripts.delete(nextAppendSeq);
    nextAppendSeq += 1;
    if (entry.ok && entry.text) {
      finalTranscript += (finalTranscript ? ' ' : '') + entry.text;
      renderTranscript();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WHISPER ERROR FUNNEL
// ─────────────────────────────────────────────────────────────────────────────
function whisperMessageFor(kind, detail) {
  switch (kind) {
    case 'missing-key':
      return 'Whisper transcription needs a Groq API key. Paste one into the Groq backend settings (the key is stored locally).';
    case 'mic-denied':
      return 'Mic transcription unavailable: microphone access was denied.';
    case 'fetch-network-error':
      return 'Whisper transcription failed: could not reach the transcription service. Check network or endpoint.';
    case 'http-non-2xx': {
      const status = (detail && detail.status != null) ? detail.status : '?';
      const body = (detail && detail.body) ? String(detail.body).slice(0, 300) : '';
      return 'Whisper transcription failed: HTTP ' + status + '. ' + body;
    }
    case 'malformed-json':
      return 'Whisper transcription failed: response was not valid JSON or did not contain a transcript.';
    default:
      return 'Whisper transcription failed.';
  }
}

function reportError(kind, detail) {
  if (errored) return;
  errored = true;
  const message = whisperMessageFor(kind, detail);
  showTranscriptError(message);
  setStatus('mic stopped due to error', false);
  if (kind === 'mic-denied' && L.platform === 'darwin') {
    try { L.openMicPerms(); } catch (e) { /* ignore */ }
  }
  stopWhisper();
}

// ─────────────────────────────────────────────────────────────────────────────
// WHISPER STATUS LINE
// ─────────────────────────────────────────────────────────────────────────────
function updateStatusLine() {
  if (errored) return;
  if (listening) {
    if (inFlight > 0) setStatus('transcribing…', true);
    else setStatus('listening…', true);
  } else {
    setStatus('listening stopped', false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIC LISTENING
// ─────────────────────────────────────────────────────────────────────────────
transcriptUse.addEventListener('click', () => {
  input.value = (finalTranscript + interimTranscript).trim();
  showPane('chat');
  input.focus();
});
transcriptAppend.addEventListener('click', () => {
  const t = (finalTranscript + interimTranscript).trim();
  if (!t) return;
  input.value = (input.value ? input.value + '\n\n' : '') + t;
  showPane('chat');
  input.focus();
});
transcriptClear.addEventListener('click', () => {
  finalTranscript = ''; interimTranscript = ''; renderTranscript();
});

function renderTranscript() {
  transcriptText.innerHTML = '';
  if (finalTranscript) {
    const f = document.createElement('span');
    f.textContent = finalTranscript;
    transcriptText.appendChild(f);
  }
  if (interimTranscript) {
    const i = document.createElement('span');
    i.className = 'interim';
    i.textContent = interimTranscript;
    transcriptText.appendChild(i);
  }
  transcriptText.scrollTop = transcriptText.scrollHeight;
}
function showTranscriptError(message) {
  transcriptWrap.hidden = false;
  const el = document.createElement('div');
  el.className = 'err';
  el.textContent = message;
  transcriptText.innerHTML = '';
  transcriptText.appendChild(el);
}
function updateListenUI() {
  if (listening) {
    if (listenLabel) listenLabel.textContent = 'Stop listening';
    listenBtn.classList.add('active');
    if (micInputBtn) { micInputBtn.classList.add('active'); micInputBtn.textContent = '⏹ Stop'; }
    earEl.textContent = '🎤 on';
    transcriptWrap.hidden = false;
    transcriptLang.textContent = '';
  } else {
    if (listenLabel) listenLabel.textContent = 'Listen';
    listenBtn.classList.remove('active');
    if (micInputBtn) { micInputBtn.classList.remove('active'); micInputBtn.textContent = '🎤 Listen'; }
    earEl.textContent = '🎤 off';
  }
}
async function toggleListen() {
  if (listening) {
    stopWhisper();
    return;
  }
  if (!readGroqKey()) {
    reportError('missing-key');
    return;
  }
  await startWhisper();
}

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTION CHECK
// ─────────────────────────────────────────────────────────────────────────────
async function check() {
  if (backendSel.value === 'echo') return setStatus('echo mode', true);
  if (backendSel.value === 'groq') {
    const k = currentKey(); if (!k) return setStatus('paste a Groq API key', false);
    try {
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + k } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const has = (d.data || []).some(m => m.id === modelInput.value);
      setStatus(has ? 'ready (' + modelInput.value + ')' : 'key works, model id not found', has);
    } catch (e) { setStatus('key check failed: ' + e.message, false); }
    return;
  }
  if (backendSel.value === 'gemini') {
    const k = currentKey(); if (!k) return setStatus('paste a Gemini API key', false);
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(k));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const has = (d.models || []).some(m => m.name.endsWith('/' + modelInput.value));
      setStatus(has ? 'ready (' + modelInput.value + ')' : 'key works, model name not found', has);
    } catch (e) { setStatus('key check failed: ' + e.message, false); }
    return;
  }
  if (backendSel.value === 'ollama') {
    try {
      const r = await fetch(ollamaUrlInput.value.replace(/\/$/,'') + '/api/tags');
      if (!r.ok) throw 0;
      const d = await r.json();
      const has = (d.models || []).some(m => m.name === modelInput.value || m.name.startsWith(modelInput.value));
      setStatus(has ? 'ready (' + modelInput.value + ')' : 'connected, model not pulled', has);
    } catch { setStatus('ollama not reachable', false); }
  }
}
pingBtn.addEventListener('click', check);

// ─────────────────────────────────────────────────────────────────────────────
// LLM BACKENDS (with optional image attachment)
// ─────────────────────────────────────────────────────────────────────────────
function systemPrompt(hasImage) {
  const base = hasImage
    ? 'You are Lumen, a concise privacy-first desktop overlay. A live screenshot of the user\'s screen is attached. Look at it carefully and ground your answer in what you actually see.'
    : 'You are Lumen, a concise privacy-first desktop overlay.';
  // Negative prompt — what to AVOID. User-customizable via Settings.
  const negative = (localStorage.getItem('lumen.negativePrompt') || DEFAULT_NEGATIVE_PROMPT).trim();
  return base + ' Keep answers tight and grounded. ' + negative;
}

const DEFAULT_NEGATIVE_PROMPT = [
  'Do not invent information that is not visible in the attached image or stated by the user.',
  'Do not pad with disclaimers, boilerplate, or restating the question.',
  'Do not use marketing language, hype, or filler ("In conclusion…", "I hope this helps…", "As an AI…").',
  'Do not list every option when one clear answer is best.',
  'Do not over-explain when the user asked for a short answer.',
].join(' ');

async function streamGroq(target, image) {
  const k = currentKey();
  if (!k) { target.textContent = 'No Groq API key.'; target.classList.add('err'); return; }
  const priorTurns = history.slice(0, -1);
  const lastUserText = history[history.length - 1].content;
  const userContent = image
    ? [{ type: 'text', text: lastUserText }, { type: 'image_url', image_url: { url: image } }]
    : lastUserText;
  // When an image is attached, force a vision-capable model — text models reject
  // the array `content` shape with a 400 "must be a string".
  const modelToUse = image ? (VISION_DEFAULTS.groq || modelInput.value) : modelInput.value;
  const body = {
    model: modelToUse, stream: true, temperature: 0.3,
    messages: [{ role: 'system', content: systemPrompt(!!image) }, ...priorTurns, { role: 'user', content: userContent }],
  };
  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: JSON.stringify(body),
    });
  } catch (e) { target.textContent = 'Network error: ' + e.message; target.classList.add('err'); return; }
  if (!res.ok) { const t = await res.text(); target.textContent = 'Groq ' + res.status + ': ' + t.slice(0, 300); target.classList.add('err'); return; }
  await streamSSE(res, target);
}

async function streamGemini(target, image) {
  const k = currentKey();
  if (!k) { target.textContent = 'No Gemini API key.'; target.classList.add('err'); return; }
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(image ? (VISION_DEFAULTS.gemini || modelInput.value) : modelInput.value)
            + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(k);
  const priorTurns = history.slice(0, -1);
  const lastUserText = history[history.length - 1].content;
  const contents = priorTurns.map(m => ({ role: m.role === 'assistant' ? 'model' : m.role, parts: [{ text: m.content }] }));
  const lastParts = [{ text: lastUserText }];
  if (image) lastParts.unshift({ inline_data: { mime_type: 'image/jpeg', data: image.split(',')[1] } });
  contents.push({ role: 'user', parts: lastParts });
  const body = { contents, systemInstruction: { parts: [{ text: systemPrompt(!!image) }] }, generationConfig: { temperature: 0.3 } };
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { target.textContent = 'Network error: ' + e.message; target.classList.add('err'); return; }
  if (!res.ok) { const t = await res.text(); target.textContent = 'Gemini ' + res.status + ': ' + t.slice(0, 300); target.classList.add('err'); return; }

  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', full = '';
  const cur = document.createElement('span'); cur.className = 'cursor'; target.textContent = ''; target.appendChild(cur);
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim(); if (data === '[DONE]') break;
      try {
        const obj = JSON.parse(data);
        const parts = obj?.candidates?.[0]?.content?.parts || [];
        for (const p of parts) {
          if (p.text) { full += p.text; cur.remove(); target.textContent = full; target.appendChild(cur); chat.scrollTop = chat.scrollHeight; }
        }
      } catch {}
    }
  }
  cur.remove();
  history.push({ role: 'assistant', content: full });
}

async function streamOllama(target, image) {
  const priorTurns = history.slice(0, -1);
  const lastUserText = history[history.length - 1].content;
  const lastUserMsg = { role: 'user', content: lastUserText };
  if (image) lastUserMsg.images = [image.split(',')[1]];
  let res;
  try {
    res = await fetch(ollamaUrlInput.value.replace(/\/$/,'') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: image ? (VISION_DEFAULTS.ollama || modelInput.value) : modelInput.value, stream: true,
        messages: [{ role: 'system', content: systemPrompt(!!image) }, ...priorTurns, lastUserMsg],
      }),
    });
  } catch { target.textContent = 'Cannot reach Ollama.'; target.classList.add('err'); return; }
  if (!res.ok) { target.textContent = 'Ollama ' + res.status; target.classList.add('err'); return; }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', full = '';
  const cur = document.createElement('span'); cur.className = 'cursor'; target.textContent = ''; target.appendChild(cur);
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o.message && o.message.content) {
          full += o.message.content; cur.remove(); target.textContent = full; target.appendChild(cur);
          chat.scrollTop = chat.scrollHeight;
        }
      } catch {}
    }
  }
  cur.remove();
  history.push({ role: 'assistant', content: full });
}

async function streamSSE(res, target) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', full = '';
  const cur = document.createElement('span'); cur.className = 'cursor'; target.textContent = ''; target.appendChild(cur);
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { cur.remove(); history.push({ role: 'assistant', content: full }); return; }
      try {
        const obj = JSON.parse(data);
        const d = obj?.choices?.[0]?.delta?.content;
        if (d) { full += d; cur.remove(); target.textContent = full; target.appendChild(cur); chat.scrollTop = chat.scrollHeight; }
      } catch {}
    }
  }
  cur.remove();
  history.push({ role: 'assistant', content: full });
}

// ─────────────────────────────────────────────────────────────────────────────
// ASK
// ─────────────────────────────────────────────────────────────────────────────
async function ask() {
  const t = input.value.trim(); if (!t) return;
  showPane('chat');
  // Prefer a live screen-share frame; otherwise use a one-shot pendingSnap if present.
  let image = screenStream ? captureFrame() : null;
  if (!image && pendingSnap) { image = pendingSnap; pendingSnap = null; }
  const userBubble = addMsg('user', t);
  if (image) attachThumb(userBubble, image);
  input.value = '';
  const target = addAssistantPlaceholder();
  history.push({ role: 'user', content: t });
  if (backendSel.value === 'echo') {
    await new Promise(r => setTimeout(r, 200));
    target.textContent = image ? 'Echo (would have looked at the screen): ' + t : 'Echo: ' + t;
    history.push({ role: 'assistant', content: target.textContent });
    return;
  }
  if (backendSel.value === 'groq')   return streamGroq(target, image);
  if (backendSel.value === 'gemini') return streamGemini(target, image);
  if (backendSel.value === 'ollama') return streamOllama(target, image);
}

sendBtn.addEventListener('click', ask);
clearBtn.addEventListener('click', () => {
  history = [];
  chat.innerHTML = '';
  recent.length = 0;
  renderRecent();
});
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); }
});

// Global hotkeys at the document level: ⌘K clear, ? open hotkeys, Esc close modal.
document.addEventListener('keydown', e => {
  // Esc closes the hotkeys modal regardless of focus.
  if (e.key === 'Escape' && hotkeysModal && !hotkeysModal.hidden) {
    e.preventDefault();
    closeHotkeys();
    return;
  }
  // ⌘K (or Ctrl+K) clears chat from anywhere except inside text fields where it
  // would conflict — only fire when the input doesn't have focus or when the
  // input is empty.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    if (document.activeElement !== input || input.value === '') {
      e.preventDefault();
      clearBtn.click();
    }
  }
  // `?` opens hotkeys (only when not typing into an input/textarea).
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (e.key === '?' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
    e.preventDefault();
    openHotkeys();
  }
});

// Initial connection probe.
check();

// Native title-attribute init — platform-aware modifier.
const _mod = L.platform === 'darwin' ? 'Cmd' : 'Ctrl';
sendBtn.title = 'Send (' + _mod + '+Enter)';
opacityBtn.title = 'Cycle opacity (' + _mod + '+Shift+O)';
listenBtn.title = 'Toggle microphone listening (Whisper)';
shareBtn.title = 'Toggle screen sharing';
clearBtn.title = 'Clear chat history';
savekeyBtn.title = 'Save API key to local storage';
clearkeyBtn.title = 'Remove the saved API key';
pingBtn.title = 'Check connection to the selected backend';
transcriptUse.title = 'Replace the input with the current transcript';
transcriptAppend.title = 'Append the current transcript to the input';
transcriptClear.title = 'Clear the current transcript';


// ── Settings pane: negative prompt + translate language + about links ──────
const negPromptEl = $('neg-prompt');
const negSaveBtn = $('neg-save');
const negResetBtn = $('neg-reset');
const translateLangEl = $('translate-lang');
const aboutLinkedin = $('about-linkedin');
const aboutCoffee = $('about-coffee');
const aboutHotkeys = $('about-hotkeys');

if (negPromptEl) {
  negPromptEl.value = localStorage.getItem('lumen.negativePrompt') || DEFAULT_NEGATIVE_PROMPT;
}
if (negSaveBtn) {
  negSaveBtn.addEventListener('click', () => {
    const v = (negPromptEl.value || '').trim();
    if (v) localStorage.setItem('lumen.negativePrompt', v);
    else localStorage.removeItem('lumen.negativePrompt');
    setStatus('negative prompt saved', true);
  });
}
if (negResetBtn) {
  negResetBtn.addEventListener('click', () => {
    localStorage.removeItem('lumen.negativePrompt');
    if (negPromptEl) negPromptEl.value = DEFAULT_NEGATIVE_PROMPT;
    setStatus('negative prompt reset', true);
  });
}
if (translateLangEl) {
  translateLangEl.value = localStorage.getItem('lumen.translateLang') || '';
  translateLangEl.addEventListener('change', () => {
    const v = (translateLangEl.value || '').trim();
    if (v) localStorage.setItem('lumen.translateLang', v);
    else localStorage.removeItem('lumen.translateLang');
  });
}

// External links open in the user's default browser.
function openExternal(url) {
  // Electron forwards http(s) clicks via shell.openExternal under the hood
  // when window.open is used — but contextIsolation blocks shell directly.
  // Easiest reliable path: `window.open(url, '_blank')` — Electron's default
  // window-open handler on a privileged scheme routes to the OS browser.
  try { window.open(url, '_blank', 'noopener'); } catch (e) {}
}
if (aboutLinkedin) {
  aboutLinkedin.addEventListener('click', () => openExternal('https://www.linkedin.com/in/sonu-kumar-99a860354'));
}
if (aboutCoffee) {
  aboutCoffee.addEventListener('click', () => {
    const url = localStorage.getItem('lumen.coffeeUrl') || 'https://buymeacoffee.com/sonukumar';
    openExternal(url);
  });
}
if (aboutHotkeys) {
  aboutHotkeys.addEventListener('click', openHotkeys);
}
