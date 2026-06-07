// Lumen — renderer.
// All chat backend logic, screen capture, and mic transcription live here.
// `window.lumen` (from preload) is available in Electron; in a plain browser
// we fall back to no-ops so the same file still works.

// ── License gate disabled (was blocking activation in packaged build) ──────
// Distribution control is now via "only ship the .dmg to invited users".

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
const modelPicker = $('model-picker'), modelCustomToggle = $('model-custom-toggle');
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
const LS_HISTORY = 'lumen.chatHistory';
const HISTORY_MAX_TURNS = 40; // keep last 40 turns (20 exchanges) to stay within context limits

function loadHistory() {
  try {
    const raw = localStorage.getItem(LS_HISTORY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch { return []; }
}

function saveHistory() {
  try {
    // Trim to last N turns before saving to avoid unbounded growth
    const trimmed = history.slice(-HISTORY_MAX_TURNS);
    localStorage.setItem(LS_HISTORY, JSON.stringify(trimmed));
  } catch {}
}

let history = loadHistory();           // persisted conversation history across sessions
let screenStream = null;               // active MediaStream when screen-sharing
let prevTextModel = null;              // remember text model so we can restore on stop
let listening = false;
let finalTranscript = '';
let interimTranscript = '';
let lastCheckOk = false;               // result of the most recent check()
let alwaysOnTop = true;                // visual toggle only — main.js sets the real flag

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
// Silence detection — Whisper hallucinates ("Thank you", "E aí", etc.) when
// fed near-silent audio. We measure RMS of the live mic stream and refuse
// to POST chunks whose peak RMS over the chunk window is below threshold.
let audioCtx = null;
let analyserNode = null;
let rmsSampleTimer = null;
let currentChunkPeakRMS = 0;
const SILENCE_RMS_DEFAULT = 0.018;
function readSilenceThreshold() {
  const raw = localStorage.getItem('lumen.whisper.silenceRms');
  if (raw == null || raw === '') return SILENCE_RMS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return SILENCE_RMS_DEFAULT;
  return n;
}

// ── Model defaults & vision swaps ───────────────────────────────────────────
const TEXT_DEFAULTS = {
  groq:     'llama-3.3-70b-versatile',
  gemini:   'gemini-2.0-flash-lite',
  ollama:   'llama3.2',
  openai:   'gpt-4.1',
  claude:   'claude-opus-4-8',
  deepseek: 'deepseek-chat',
  grok:     'grok-4',
  mistral:  'mistral-large-latest',
  nvidia:   'deepseek-ai/deepseek-v4-flash',
};
const VISION_DEFAULTS = {
  groq:     'meta-llama/llama-4-scout-17b-16e-instruct',
  gemini:   'gemini-2.0-flash',
  ollama:   'llava',
  openai:   'gpt-4o',
  claude:   'claude-opus-4-8',
  deepseek: 'deepseek-chat',
  grok:     'grok-4',
  mistral:  'pixtral-large-latest',
  nvidia:   'deepseek-ai/deepseek-v4-flash',
};
const VISION_HINTS = {
  groq:     'vision: llama-4-scout / llama-4-maverick',
  gemini:   'vision: gemini-2.0-flash, gemini-2.5-pro',
  ollama:   'vision: llava, llama3.2-vision, bakllava',
  openai:   'vision: gpt-4o, gpt-4.1 (use gpt-4o for images)',
  claude:   'vision: claude-opus-4-8, claude-sonnet-4-6',
  deepseek: 'text only via API — deepseek-chat (V3), deepseek-reasoner (R1)',
  grok:     'vision: grok-4 supports images',
  mistral:  'vision: pixtral-large-latest, pixtral-12b-2409',
  nvidia:   'NVIDIA NIM — deepseek-v4-flash, llama-3.1-405b, mistral-large, etc.',
};

// ── Known model catalogues ────────────────────────────────────────────────────
const MODEL_CATALOGUE = {
  groq: [
    { id: 'llama-3.3-70b-versatile',                       label: 'Llama 3.3 70B Versatile (default)' },
    { id: 'llama-3.1-8b-instant',                          label: 'Llama 3.1 8B Instant (fast)' },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct',     label: 'Llama 4 Scout 17B (vision)' },
    { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick 17B (vision)' },
    { id: 'mixtral-8x7b-32768',                            label: 'Mixtral 8x7B 32k' },
    { id: 'gemma2-9b-it',                                  label: 'Gemma 2 9B' },
  ],
  gemini: [
    { id: 'gemini-2.0-flash-lite',          label: 'Gemini 2.0 Flash Lite (default)' },
    { id: 'gemini-2.0-flash',               label: 'Gemini 2.0 Flash (vision)' },
    { id: 'gemini-2.5-flash-preview-05-20', label: 'Gemini 2.5 Flash Preview' },
    { id: 'gemini-2.5-pro-preview-06-05',   label: 'Gemini 2.5 Pro Preview' },
    { id: 'gemini-1.5-flash',               label: 'Gemini 1.5 Flash' },
    { id: 'gemini-1.5-pro',                 label: 'Gemini 1.5 Pro' },
  ],
  openai: [
    { id: 'gpt-4.1',      label: 'GPT-4.1 (default, latest)' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini (fast)' },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano (cheapest)' },
    { id: 'gpt-4o',       label: 'GPT-4o (vision)' },
    { id: 'gpt-4o-mini',  label: 'GPT-4o Mini' },
    { id: 'o1',           label: 'o1 (reasoning)' },
    { id: 'o1-mini',      label: 'o1 Mini' },
    { id: 'o3',           label: 'o3 (advanced reasoning)' },
    { id: 'o3-mini',      label: 'o3 Mini' },
    { id: 'o4-mini',      label: 'o4 Mini' },
  ],
  claude: [
    { id: 'claude-opus-4-8',            label: 'Claude Opus 4.8 (latest)' },
    { id: 'claude-opus-4-7',            label: 'Claude Opus 4.7' },
    { id: 'claude-opus-4-5-20251101',   label: 'Claude Opus 4.5' },
    { id: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6' },
    { id: 'claude-sonnet-4-5-20251120', label: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5',           label: 'Claude Haiku 4.5 (fastest)' },
    { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-5-haiku-20241022',  label: 'Claude 3.5 Haiku' },
    { id: 'claude-3-opus-20240229',     label: 'Claude 3 Opus' },
  ],
  deepseek: [
    { id: 'deepseek-chat',     label: 'DeepSeek V3 / deepseek-chat (default)' },
    { id: 'deepseek-reasoner', label: 'DeepSeek R1 / deepseek-reasoner (reasoning)' },
  ],
  grok: [
    { id: 'grok-4',             label: 'Grok 4 (default, latest)' },
    { id: 'grok-3',             label: 'Grok 3' },
    { id: 'grok-3-mini',        label: 'Grok 3 Mini (fast)' },
    { id: 'grok-2-vision-1212', label: 'Grok 2 Vision' },
    { id: 'grok-2-1212',        label: 'Grok 2' },
  ],
  mistral: [
    { id: 'mistral-large-latest',  label: 'Mistral Large (default)' },
    { id: 'mistral-medium-latest', label: 'Mistral Medium' },
    { id: 'mistral-small-latest',  label: 'Mistral Small (fast)' },
    { id: 'open-mistral-nemo',     label: 'Mistral Nemo (open)' },
    { id: 'pixtral-large-latest',  label: 'Pixtral Large (vision)' },
    { id: 'pixtral-12b-2409',      label: 'Pixtral 12B (vision)' },
    { id: 'codestral-latest',      label: 'Codestral (coding)' },
  ],
  nvidia: [
    { id: 'deepseek-ai/deepseek-v4-flash',          label: 'DeepSeek V4 Flash (default, reasoning)' },
    { id: 'deepseek-ai/deepseek-r1',                label: 'DeepSeek R1' },
    { id: 'meta/llama-3.1-405b-instruct',           label: 'Llama 3.1 405B' },
    { id: 'meta/llama-3.3-70b-instruct',            label: 'Llama 3.3 70B' },
    { id: 'mistralai/mistral-large-2-instruct',     label: 'Mistral Large 2' },
    { id: 'mistralai/mixtral-8x22b-instruct-v0.1',  label: 'Mixtral 8x22B' },
    { id: 'google/gemma-3-27b-it',                  label: 'Gemma 3 27B' },
    { id: 'qwen/qwen3-235b-a22b',                   label: 'Qwen 3 235B' },
  ],
  ollama: [
    { id: 'llama3.2',        label: 'Llama 3.2 (default)' },
    { id: 'llama3.1',        label: 'Llama 3.1' },
    { id: 'llama3.1:70b',    label: 'Llama 3.1 70B' },
    { id: 'llava',           label: 'LLaVA (vision)' },
    { id: 'llama3.2-vision', label: 'Llama 3.2 Vision' },
    { id: 'mistral',         label: 'Mistral 7B' },
    { id: 'deepseek-r1',     label: 'DeepSeek R1 (reasoning)' },
    { id: 'qwen2.5',         label: 'Qwen 2.5' },
    { id: 'gemma3',          label: 'Gemma 3' },
    { id: 'phi4',            label: 'Phi-4' },
  ],
  echo: [],
};

// ── Key storage ─────────────────────────────────────────────────────────────
const keyName = () => 'lumen.key.' + backendSel.value;
const LS_BACKEND = 'lumen.backend';
const LS_MODEL_PREFIX = 'lumen.model.';

// ── Model picker ─────────────────────────────────────────────────────────────
let _pickerIsCustom = false;

function populateModelPicker(backend) {
  if (!modelPicker) return;
  const models = MODEL_CATALOGUE[backend] || [];
  modelPicker.innerHTML = '';
  if (models.length === 0) {
    modelPicker.style.display = 'none';
    modelInput.style.display = '';
    if (modelCustomToggle) modelCustomToggle.style.display = 'none';
    return;
  }
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id; opt.textContent = m.label;
    modelPicker.appendChild(opt);
  });
  const sep = document.createElement('option');
  sep.value = '__custom__'; sep.textContent = '✏️ Custom model ID…';
  modelPicker.appendChild(sep);
  const saved = localStorage.getItem(LS_MODEL_PREFIX + backend) || TEXT_DEFAULTS[backend] || '';
  const inList = models.some(m => m.id === saved);
  if (inList || !saved) {
    modelPicker.value = saved || models[0].id;
    modelInput.value = modelPicker.value;
    modelInput.style.display = 'none'; modelPicker.style.display = '';
    if (modelCustomToggle) modelCustomToggle.textContent = '✏️ Custom model ID';
    _pickerIsCustom = false;
  } else {
    modelPicker.value = '__custom__'; modelInput.value = saved;
    modelInput.style.display = ''; modelPicker.style.display = 'none';
    if (modelCustomToggle) modelCustomToggle.textContent = '← Back to model list';
    _pickerIsCustom = true;
  }
}

if (modelPicker) {
  modelPicker.addEventListener('change', () => {
    if (modelPicker.value === '__custom__') {
      modelInput.value = ''; modelInput.style.display = ''; modelPicker.style.display = 'none';
      if (modelCustomToggle) modelCustomToggle.textContent = '← Back to model list';
      _pickerIsCustom = true; modelInput.focus();
    } else {
      modelInput.value = modelPicker.value;
      localStorage.setItem(LS_MODEL_PREFIX + backendSel.value, modelInput.value);
    }
  });
}
if (modelCustomToggle) {
  modelCustomToggle.addEventListener('click', () => {
    if (_pickerIsCustom) { populateModelPicker(backendSel.value); }
    else {
      modelInput.style.display = ''; modelPicker.style.display = 'none';
      if (modelCustomToggle) modelCustomToggle.textContent = '← Back to model list';
      _pickerIsCustom = true; modelInput.focus();
    }
  });
}

backendSel.value = localStorage.getItem(LS_BACKEND) || 'groq';
apikeyInput.value = localStorage.getItem(keyName()) || '';
syncRows();
updateLcPill();
populateModelPicker(backendSel.value);

function syncRows() {
  keyRow.hidden = (backendSel.value === 'echo' || backendSel.value === 'ollama');
  ollamaRow.hidden = backendSel.value !== 'ollama';
  keyLabel.textContent =
      backendSel.value === 'groq'     ? 'Groq API key (starts with gsk_…)'
    : backendSel.value === 'gemini'   ? 'Gemini API key (starts with AIza…)'
    : backendSel.value === 'openai'   ? 'OpenAI API key (starts with sk-…)'
    : backendSel.value === 'claude'   ? 'Anthropic API key (starts with sk-ant-…)'
    : backendSel.value === 'deepseek' ? 'DeepSeek API key (starts with sk-…)'
    : backendSel.value === 'grok'     ? 'xAI API key (starts with xai-…)'
    : backendSel.value === 'mistral'  ? 'Mistral API key'
    : backendSel.value === 'nvidia'   ? 'NVIDIA NIM API key (starts with nvapi-…)'
    : 'API key';
  apikeyInput.placeholder =
      backendSel.value === 'groq'     ? 'gsk_…'
    : backendSel.value === 'gemini'   ? 'AIza…'
    : backendSel.value === 'openai'   ? 'sk-…'
    : backendSel.value === 'claude'   ? 'sk-ant-…'
    : backendSel.value === 'deepseek' ? 'sk-…'
    : backendSel.value === 'grok'     ? 'xai-…'
    : backendSel.value === 'mistral'  ? 'your-mistral-key'
    : backendSel.value === 'nvidia'   ? 'nvapi-…'
    : '';
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
  apikeyInput.value = localStorage.getItem(keyName()) || '';
  prevTextModel = null;
  syncRows();
  updateLcPill();
  populateModelPicker(backendSel.value);
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

// ── Chat zoom (A− / A+ / ⌘+ / ⌘− / ⌘0) ───────────────────────────────────
const CHAT_ZOOM_KEY = 'lumen.chatZoom';
const CHAT_ZOOM_MIN = 10;
const CHAT_ZOOM_MAX = 22;
const CHAT_ZOOM_DEFAULT = 12.5;

function loadChatZoom() {
  const raw = localStorage.getItem(CHAT_ZOOM_KEY);
  const n = Number(raw);
  if (Number.isFinite(n) && n >= CHAT_ZOOM_MIN && n <= CHAT_ZOOM_MAX) return n;
  return CHAT_ZOOM_DEFAULT;
}

function applyChatZoom(px) {
  const n = Math.max(CHAT_ZOOM_MIN, Math.min(CHAT_ZOOM_MAX, Number(px) || CHAT_ZOOM_DEFAULT));
  document.documentElement.style.setProperty('--chat-font', n + 'px');
  // Keep the timestamp/meta line proportional (~80% of body).
  document.documentElement.style.setProperty('--chat-meta-font', (n * 0.8).toFixed(2) + 'px');
  localStorage.setItem(CHAT_ZOOM_KEY, String(n));
  return n;
}

let currentChatZoom = applyChatZoom(loadChatZoom());

function bumpChatZoom(delta) {
  currentChatZoom = applyChatZoom(currentChatZoom + delta);
}

function resetChatZoom() {
  currentChatZoom = applyChatZoom(CHAT_ZOOM_DEFAULT);
}

const zoomInBtn = $('zoom-in');
const zoomOutBtn = $('zoom-out');
if (zoomInBtn) zoomInBtn.addEventListener('click', () => bumpChatZoom(+1));
if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => bumpChatZoom(-1));

// ⌘+ / ⌘= / ⌘− / ⌘0 keyboard shortcuts. Use code-based keys so layout
// quirks (= vs +, with/without shift) still work.
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd') {
    e.preventDefault(); bumpChatZoom(+1);
  } else if (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
    e.preventDefault(); bumpChatZoom(-1);
  } else if (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') {
    e.preventDefault(); resetChatZoom();
  }
});


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

function onDataAvailable(e) {
  // `e.target` is the recorder that just flushed. Read the peak RMS we
  // snapshotted onto it before stop() — falls back to current if absent
  // (e.g. on natural stopWhisper teardown of the active recorder).
  const rec = e && e.target;
  const peak = (rec && typeof rec._peakRMS === 'number') ? rec._peakRMS : currentChunkPeakRMS;
  enqueueChunk(e.data, peak);
}

async function startWhisper() {
  let stream;
  try {
    // Use the system default input (changes correctly when you plug in
    // headphones). Constraints disable echo/noise/AGC tweaks so Whisper
    // gets the cleanest possible audio.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    reportError('mic-denied', e);
    return;
  }
  mediaStream = stream;

  // ── Silence detector — sample RMS at 100ms cadence ───────────────────
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      audioCtx = new Ctx();
      const src = audioCtx.createMediaStreamSource(mediaStream);
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 1024;
      src.connect(analyserNode);
      // NOTE: do NOT connect analyser to destination — would echo mic to speakers.
      const buf = new Float32Array(analyserNode.fftSize);
      currentChunkPeakRMS = 0;
      rmsSampleTimer = setInterval(() => {
        try {
          analyserNode.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          if (rms > currentChunkPeakRMS) currentChunkPeakRMS = rms;
        } catch (_) { /* ignore */ }
      }, 100);
    }
  } catch (_) { audioCtx = null; analyserNode = null; }

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
  // Snapshot peak RMS for the chunk that's about to flush, then reset for
  // the new chunk window. The peak is read inside enqueueChunk via
  // currentChunkPeakRMS — set on the recorder instance before stop() so the
  // synchronous ondataavailable can read it.
  try { mediaRecorder._peakRMS = currentChunkPeakRMS; } catch (_) {}
  currentChunkPeakRMS = 0;
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
  if (rmsSampleTimer) {
    clearInterval(rmsSampleTimer);
    rmsSampleTimer = null;
  }
  // Snapshot peak for the trailing chunk so the silence gate can evaluate it.
  try { if (mediaRecorder) mediaRecorder._peakRMS = currentChunkPeakRMS; } catch (_) {}
  currentChunkPeakRMS = 0;
  try { mediaRecorder && mediaRecorder.stop(); } catch (e) { /* ignore */ }
  if (audioCtx) {
    try { audioCtx.close(); } catch (_) { /* ignore */ }
    audioCtx = null;
    analyserNode = null;
  }
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
// Whisper hallucinates short phrases like "Thank you" / "Thanks for watching"
// when fed near-silent audio. Filter ONLY exact-match common hallucinations,
// not by length (short real words like "yes" / "ok" are fine).
const HALLUCINATIONS = new Set([
  'thanks for watching', 'thanks for watching!',
  'subtitles by the amara.org community',
  'please subscribe', 'like and subscribe',
]);
function filterHallucinations(text) {
  if (!text) return '';
  const norm = text.trim().toLowerCase().replace(/[.!,?]+$/, '');
  if (HALLUCINATIONS.has(norm)) return '';
  return text;
}

function enqueueChunk(blob, peakRMS) {
  if (!blob || blob.size === 0) return;
  // Drop near-silent chunks before they reach Whisper — prevents
  // hallucinated transcripts ("Thank you", "E aí", "Tchau", etc.) on
  // pauses or background-noise-only audio.
  const peak = (typeof peakRMS === 'number') ? peakRMS : currentChunkPeakRMS;
  const threshold = readSilenceThreshold();
  if (peak < threshold) {
    // Skip silently — do NOT increment chunkSeq, do NOT post.
    return;
  }
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
    const cleaned = filterHallucinations(String(parsed.text).trim());
    pendingTranscripts.set(seq, { ok: true, text: cleaned });
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
      const r = await apiFetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + k } });
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
      const r = await apiFetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(k));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const has = (d.models || []).some(m => m.name.endsWith('/' + modelInput.value));
      setStatus(has ? 'ready (' + modelInput.value + ')' : 'key works, model name not found', has);
    } catch (e) { setStatus('key check failed: ' + e.message, false); }
    return;
  }
  if (backendSel.value === 'openai') {
    const k = currentKey(); if (!k) return setStatus('paste an OpenAI API key', false);
    try {
      const r = await apiFetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + k } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const has = (d.data || []).some(m => m.id === modelInput.value);
      setStatus(has ? 'ready (' + modelInput.value + ')' : 'key works, model id not found', has);
    } catch (e) { setStatus('key check failed: ' + e.message, false); }
    return;
  }
  if (backendSel.value === 'claude') {
    const k = currentKey(); if (!k) return setStatus('paste an Anthropic API key', false);
    try {
      const r = await apiFetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const has = (d.data || []).some(m => m.id === modelInput.value);
      setStatus(has ? 'ready (' + modelInput.value + ')' : 'key works, model id not found', has);
    } catch (e) { setStatus('key check failed: ' + e.message, false); }
    return;
  }
  if (backendSel.value === 'deepseek') {
    const k = currentKey(); if (!k) return setStatus('paste a DeepSeek API key', false);
    try {
      const r = await apiFetch('https://api.deepseek.com/models', { headers: { Authorization: 'Bearer ' + k } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const has = (d.data || []).some(m => m.id === modelInput.value);
      setStatus(has ? 'ready (' + modelInput.value + ')' : 'key works, model id not found', has);
    } catch (e) { setStatus('key check failed: ' + e.message, false); }
    return;
  }
  if (backendSel.value === 'grok') {
    const k = currentKey(); if (!k) return setStatus('paste an xAI API key', false);
    try {
      const r = await apiFetch('https://api.x.ai/v1/models', { headers: { Authorization: 'Bearer ' + k } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const has = (d.data || []).some(m => m.id === modelInput.value);
      setStatus(has ? 'ready (' + modelInput.value + ')' : 'key works, model id not found', has);
    } catch (e) { setStatus('key check failed: ' + e.message, false); }
    return;
  }
  if (backendSel.value === 'mistral') {
    const k = currentKey(); if (!k) return setStatus('paste a Mistral API key', false);
    try {
      const r = await apiFetch('https://api.mistral.ai/v1/models', { headers: { Authorization: 'Bearer ' + k } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const has = (d.data || []).some(m => m.id === modelInput.value);
      setStatus(has ? 'ready (' + modelInput.value + ')' : 'key works, model id not found', has);
    } catch (e) { setStatus('key check failed: ' + e.message, false); }
    return;
  }
  if (backendSel.value === 'nvidia') {
    const k = currentKey(); if (!k) return setStatus('paste an NVIDIA NIM API key (nvapi-…)', false);
    try {
      const r = await apiFetch('https://integrate.api.nvidia.com/v1/models', { headers: { Authorization: 'Bearer ' + k } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // NVIDIA model IDs use slashes (e.g. "deepseek-ai/deepseek-v4-flash") — just confirm key works
      setStatus('ready (' + modelInput.value + ')', true);
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

// apiFetch — tries direct fetch first; if it fails with a network/CORS error,
// falls back to the main-process IPC proxy (L.apiFetch) which has no CORS restrictions.
async function apiFetch(url, options) {
  // Try direct fetch first (works for most providers from lumen:// origin)
  try {
    const res = await fetch(url, options);
    return res;
  } catch (e) {
    // Network/CORS error — fall back to IPC proxy
    if (!L.apiFetch) throw e;
    const method = options.method || 'GET';
    const headers = options.headers || {};
    const body = options.body !== undefined ? options.body : null;
    const result = await L.apiFetch(url, method, headers, body);
    if (result.error) throw new Error(result.error);
    // Wrap the text result in a Response-like object that streamSSE can consume
    const encoder = new TextEncoder();
    const bytes = encoder.encode(result.text);
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    });
    return new Response(stream, {
      status: result.status,
      ok: result.ok,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
}

function systemPrompt(hasImage) {
  const base = hasImage
    ? 'You are Lumen, a concise privacy-first desktop overlay. A live screenshot of the user\'s screen is attached. Look at it carefully and ground your answer in what you actually see.'
    : 'You are Lumen, a concise privacy-first desktop overlay.';
  const negative = (localStorage.getItem('lumen.negativePrompt') || DEFAULT_NEGATIVE_PROMPT).trim();
  const docsCtx = buildDocsContext();
  return base + ' Keep answers tight and grounded. ' + negative + docsCtx;
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
    res = await apiFetch('https://api.groq.com/openai/v1/chat/completions', {
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
    res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  saveHistory();
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
  saveHistory();
}

// ── OpenAI (GPT-4.1, GPT-4o, o1, o3, o4-mini) ───────────────────────────────
async function streamOpenAI(target, image) {
  const k = currentKey();
  if (!k) { target.textContent = 'No OpenAI API key.'; target.classList.add('err'); return; }
  const priorTurns = history.slice(0, -1);
  const lastUserText = history[history.length - 1].content;
  const modelToUse = image ? (VISION_DEFAULTS.openai || modelInput.value) : modelInput.value;
  const userContent = image
    ? [{ type: 'text', text: lastUserText }, { type: 'image_url', image_url: { url: image, detail: 'high' } }]
    : lastUserText;
  const body = {
    model: modelToUse, stream: true, temperature: 0.3,
    messages: [{ role: 'system', content: systemPrompt(!!image) }, ...priorTurns, { role: 'user', content: userContent }],
  };
  let res;
  try {
    res = await apiFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: JSON.stringify(body),
    });
  } catch (e) { target.textContent = 'Network error: ' + e.message; target.classList.add('err'); return; }
  if (!res.ok) { const t = await res.text(); target.textContent = 'OpenAI ' + res.status + ': ' + t.slice(0, 300); target.classList.add('err'); return; }
  await streamSSE(res, target);
}

// ── Claude (Anthropic) ────────────────────────────────────────────────────────
async function streamClaude(target, image) {
  const k = currentKey();
  if (!k) { target.textContent = 'No Anthropic API key.'; target.classList.add('err'); return; }
  const priorTurns = history.slice(0, -1);
  const lastUserText = history[history.length - 1].content;
  const modelToUse = image ? (VISION_DEFAULTS.claude || modelInput.value) : modelInput.value;
  const messages = priorTurns.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  const lastContent = image
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.split(',')[1] } }, { type: 'text', text: lastUserText }]
    : lastUserText;
  messages.push({ role: 'user', content: lastContent });
  const body = { model: modelToUse, max_tokens: 2048, stream: true, system: systemPrompt(!!image), messages };
  let res;
  try {
    res = await apiFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
  } catch (e) { target.textContent = 'Network error: ' + e.message; target.classList.add('err'); return; }
  if (!res.ok) { const t = await res.text(); target.textContent = 'Claude ' + res.status + ': ' + t.slice(0, 300); target.classList.add('err'); return; }
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
        if (obj.type === 'content_block_delta' && obj.delta && obj.delta.type === 'text_delta') {
          full += obj.delta.text; cur.remove(); target.textContent = full; target.appendChild(cur); chat.scrollTop = chat.scrollHeight;
        }
        if (obj.type === 'message_stop') break;
      } catch {}
    }
  }
  cur.remove();
  history.push({ role: 'assistant', content: full });
  saveHistory();
}

// ── DeepSeek ──────────────────────────────────────────────────────────────────
async function streamDeepSeek(target, image) {
  const k = currentKey();
  if (!k) { target.textContent = 'No DeepSeek API key.'; target.classList.add('err'); return; }
  if (image) { target.textContent += '[Note: DeepSeek API does not support image input — text only]\n\n'; }
  const priorTurns = history.slice(0, -1);
  const lastUserText = history[history.length - 1].content;
  const body = {
    model: modelInput.value, stream: true, temperature: 0.3,
    messages: [{ role: 'system', content: systemPrompt(false) }, ...priorTurns, { role: 'user', content: lastUserText }],
  };
  let res;
  try {
    res = await apiFetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: JSON.stringify(body),
    });
  } catch (e) { target.textContent = 'Network error: ' + e.message; target.classList.add('err'); return; }
  if (!res.ok) { const t = await res.text(); target.textContent = 'DeepSeek ' + res.status + ': ' + t.slice(0, 300); target.classList.add('err'); return; }
  await streamSSE(res, target);
}

// ── Grok (xAI) — OpenAI-compatible ───────────────────────────────────────────
async function streamGrok(target, image) {
  const k = currentKey();
  if (!k) { target.textContent = 'No xAI API key.'; target.classList.add('err'); return; }
  const priorTurns = history.slice(0, -1);
  const lastUserText = history[history.length - 1].content;
  const modelToUse = image ? (VISION_DEFAULTS.grok || modelInput.value) : modelInput.value;
  const userContent = image
    ? [{ type: 'text', text: lastUserText }, { type: 'image_url', image_url: { url: image } }]
    : lastUserText;
  const body = {
    model: modelToUse, stream: true, temperature: 0.3,
    messages: [{ role: 'system', content: systemPrompt(!!image) }, ...priorTurns, { role: 'user', content: userContent }],
  };
  let res;
  try {
    res = await apiFetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: JSON.stringify(body),
    });
  } catch (e) { target.textContent = 'Network error: ' + e.message; target.classList.add('err'); return; }
  if (!res.ok) { const t = await res.text(); target.textContent = 'Grok ' + res.status + ': ' + t.slice(0, 300); target.classList.add('err'); return; }
  await streamSSE(res, target);
}

// ── Mistral AI ────────────────────────────────────────────────────────────────
async function streamMistral(target, image) {
  const k = currentKey();
  if (!k) { target.textContent = 'No Mistral API key.'; target.classList.add('err'); return; }
  const priorTurns = history.slice(0, -1);
  const lastUserText = history[history.length - 1].content;
  const modelToUse = image ? (VISION_DEFAULTS.mistral || modelInput.value) : modelInput.value;
  const userContent = image
    ? [{ type: 'text', text: lastUserText }, { type: 'image_url', image_url: { url: image } }]
    : lastUserText;
  const body = {
    model: modelToUse, stream: true, temperature: 0.3,
    messages: [{ role: 'system', content: systemPrompt(!!image) }, ...priorTurns, { role: 'user', content: userContent }],
  };
  let res;
  try {
    res = await apiFetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k },
      body: JSON.stringify(body),
    });
  } catch (e) { target.textContent = 'Network error: ' + e.message; target.classList.add('err'); return; }
  if (!res.ok) { const t = await res.text(); target.textContent = 'Mistral ' + res.status + ': ' + t.slice(0, 300); target.classList.add('err'); return; }
  await streamSSE(res, target);
}

// ── NVIDIA NIM (DeepSeek V4 Flash, Llama, Mistral, Qwen via NVIDIA's hosted API)
async function streamNvidia(target, image) {
  const k = currentKey();
  if (!k) { target.textContent = 'No NVIDIA NIM API key (nvapi-…).'; target.classList.add('err'); return; }
  if (image) { target.textContent += '[Note: image input skipped for text-only models]\n\n'; }
  const priorTurns = history.slice(0, -1);
  const lastUserText = history[history.length - 1].content;
  const body = {
    model: modelInput.value,
    stream: false,  // Use non-streaming since IPC proxy returns full text
    temperature: 1,
    top_p: 0.95,
    max_tokens: 4096,
    messages: [{ role: 'system', content: systemPrompt(false) }, ...priorTurns, { role: 'user', content: lastUserText }],
  };

  const cur = document.createElement('span'); cur.className = 'cursor';
  target.textContent = ''; target.appendChild(cur);

  try {
    // Always use IPC proxy for NVIDIA — avoids CORS issues with lumen:// origin
    const result = await L.apiFetch(
      'https://integrate.api.nvidia.com/v1/chat/completions',
      'POST',
      { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k },
      JSON.stringify(body)
    );
    cur.remove();
    if (!result.ok) {
      target.textContent = 'NVIDIA NIM ' + result.status + ': ' + result.text.slice(0, 300);
      target.classList.add('err'); return;
    }
    const parsed = JSON.parse(result.text);
    const content = parsed?.choices?.[0]?.message?.content || '';
    // Also show reasoning if present
    const reasoning = parsed?.choices?.[0]?.message?.reasoning_content || '';
    const full = reasoning ? '<think>\n' + reasoning + '\n</think>\n\n' + content : content;
    target.textContent = full;
    history.push({ role: 'assistant', content: content });
    saveHistory();
  } catch (e) {
    cur.remove();
    target.textContent = 'NVIDIA NIM error: ' + e.message;
    target.classList.add('err');
  }
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
      if (data === '[DONE]') { cur.remove(); history.push({ role: 'assistant', content: full }); saveHistory(); return; }
      try {
        const obj = JSON.parse(data);
        const d = obj?.choices?.[0]?.delta?.content;
        if (d) { full += d; cur.remove(); target.textContent = full; target.appendChild(cur); chat.scrollTop = chat.scrollHeight; }
      } catch {}
    }
  }
  cur.remove();
  history.push({ role: 'assistant', content: full });
  saveHistory();
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
    saveHistory();
    return;
  }
  if (backendSel.value === 'groq')     return streamGroq(target, image);
  if (backendSel.value === 'gemini')   return streamGemini(target, image);
  if (backendSel.value === 'openai')   return streamOpenAI(target, image);
  if (backendSel.value === 'claude')   return streamClaude(target, image);
  if (backendSel.value === 'deepseek') return streamDeepSeek(target, image);
  if (backendSel.value === 'grok')     return streamGrok(target, image);
  if (backendSel.value === 'mistral')  return streamMistral(target, image);
  if (backendSel.value === 'nvidia')   return streamNvidia(target, image);
  if (backendSel.value === 'ollama')   return streamOllama(target, image);
}

sendBtn.addEventListener('click', ask);
clearBtn.addEventListener('click', () => {
  history = [];
  localStorage.removeItem(LS_HISTORY);
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

// ─────────────────────────────────────────────────────────────────────────────
// PERSONAL DOCUMENTS — stored in localStorage, auto-injected into system prompt
// ─────────────────────────────────────────────────────────────────────────────
const LS_DOCS = 'lumen.personalDocs'; // [{ name, text, size, addedAt }]
const MAX_DOC_CHARS = 40000;          // ~10k tokens — keep context reasonable
const MAX_DOCS = 10;

const docUploadInput  = $('doc-upload-input');
const docList         = $('doc-list');
const docClearAll     = $('doc-clear-all');
const docStatusEl     = $('doc-status');

function loadDocs() {
  try {
    const raw = localStorage.getItem(LS_DOCS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveDocs(docs) {
  try { localStorage.setItem(LS_DOCS, JSON.stringify(docs)); } catch {}
}

function renderDocList() {
  if (!docList) return;
  const docs = loadDocs();
  docList.innerHTML = '';
  if (docs.length === 0) {
    docList.innerHTML = '<div style="color:var(--muted-2);font-size:11.5px;font-style:italic">No documents uploaded yet.</div>';
    return;
  }
  docs.forEach((doc, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:rgba(255,255,255,0.02)';
    const icon = document.createElement('span');
    icon.textContent = '📄';
    icon.style.flexShrink = '0';
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0';
    const name = document.createElement('div');
    name.style.cssText = 'font-size:12px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    name.textContent = doc.name;
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10.5px;color:var(--muted)';
    meta.textContent = Math.round(doc.text.length / 1000) + 'k chars · added ' + new Date(doc.addedAt).toLocaleDateString();
    info.appendChild(name);
    info.appendChild(meta);
    const delBtn = document.createElement('button');
    delBtn.className = 'btn ghost';
    delBtn.style.cssText = 'padding:3px 8px;font-size:11px;color:var(--danger);flex-shrink:0';
    delBtn.textContent = '✕';
    delBtn.title = 'Remove this document';
    delBtn.addEventListener('click', () => {
      const docs = loadDocs();
      docs.splice(i, 1);
      saveDocs(docs);
      renderDocList();
      updateDocStatus();
    });
    row.appendChild(icon);
    row.appendChild(info);
    row.appendChild(delBtn);
    docList.appendChild(row);
  });
}

function updateDocStatus() {
  if (!docStatusEl) return;
  const docs = loadDocs();
  if (docs.length === 0) { docStatusEl.textContent = ''; return; }
  const totalChars = docs.reduce((s, d) => s + d.text.length, 0);
  docStatusEl.textContent = docs.length + ' document' + (docs.length > 1 ? 's' : '') +
    ' stored · ~' + Math.round(totalChars / 1000) + 'k chars · injected into every AI request';
  docStatusEl.style.color = 'var(--ok)';
}

// Extract text from File — handles txt/md/csv/json directly;
// PDF/DOC are read as text (works for text-based PDFs, degrades gracefully for binary).
async function extractText(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      let text = e.target.result || '';
      // Strip null bytes and non-printable chars from binary formats
      text = text.replace(/\0/g, ' ').replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, ' ');
      text = text.replace(/\s{4,}/g, '\n').trim();
      resolve(text.slice(0, MAX_DOC_CHARS));
    };
    reader.onerror = () => resolve('');
    reader.readAsText(file);
  });
}

if (docUploadInput) {
  docUploadInput.addEventListener('change', async () => {
    const files = Array.from(docUploadInput.files || []);
    if (!files.length) return;
    const docs = loadDocs();
    let added = 0;
    if (docStatusEl) { docStatusEl.textContent = 'Reading files…'; docStatusEl.style.color = 'var(--muted)'; }
    for (const file of files) {
      if (docs.length >= MAX_DOCS) {
        if (docStatusEl) { docStatusEl.textContent = 'Max ' + MAX_DOCS + ' documents reached. Remove one first.'; docStatusEl.style.color = 'var(--danger)'; }
        break;
      }
      const text = await extractText(file);
      if (!text || text.length < 10) continue;
      // Replace existing doc with same name
      const existIdx = docs.findIndex(d => d.name === file.name);
      const entry = { name: file.name, text, addedAt: Date.now() };
      if (existIdx >= 0) docs[existIdx] = entry;
      else docs.push(entry);
      added++;
    }
    saveDocs(docs);
    renderDocList();
    updateDocStatus();
    if (added > 0 && docStatusEl) {
      docStatusEl.textContent = '✓ ' + added + ' document' + (added > 1 ? 's' : '') + ' uploaded. AI will use it automatically.';
      docStatusEl.style.color = 'var(--ok)';
    }
    docUploadInput.value = '';
  });
}

if (docClearAll) {
  docClearAll.addEventListener('click', () => {
    if (!confirm('Remove all stored documents?')) return;
    localStorage.removeItem(LS_DOCS);
    renderDocList();
    updateDocStatus();
  });
}

// Build the docs context string to inject into system prompt
function buildDocsContext() {
  const docs = loadDocs();
  if (docs.length === 0) return '';
  const parts = docs.map(d =>
    '=== Document: ' + d.name + ' ===\n' + d.text + '\n=== End of ' + d.name + ' ==='
  );
  return '\n\n--- PERSONAL DOCUMENTS (use these as context when relevant) ---\n' + parts.join('\n\n') + '\n--- END OF PERSONAL DOCUMENTS ---';
}

// Initialise on load
renderDocList();
updateDocStatus();
