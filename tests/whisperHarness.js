// Test harness for the Whisper_Client mic-transcription path described in
// .kiro/specs/whisper-mic-transcription/design.md.
//
// The harness reimplements the Whisper_Client state machine in plain JS so
// property and example tests can drive it deterministically — without
// spinning up Electron, jsdom, or a real network. It is *self-contained* and
// does NOT import from renderer/renderer.js (the renderer's Whisper path is
// created by later tasks; this harness encodes what the design says the
// Whisper_Client should do).
//
// Mocks:
//   - navigator.mediaDevices.getUserMedia
//   - MediaRecorder (constructor + start/stop spies + synchronous
//     ondataavailable wiring on stop())
//   - MediaRecorder.isTypeSupported
//   - fetch (each call returns a Promise tied to a deferred so tests can
//     resolve responses in any order)
//   - localStorage (Map-backed shim)
//   - setStatus, renderTranscript, showTranscriptError, updateListenUI as
//     spies; L.openMicPerms as a spy and L.platform as a configurable string
//
// Public API: createWhisperHarness(opts) → harness object with toggleListen,
// tickChunkInterval, resolveFetch, rejectFetch, getState, plus convenience
// counters mirroring the previous recognitionHarness pattern.

'use strict';

// ── Small utilities ─────────────────────────────────────────────────────────

function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeSpy() {
  const fn = function (...args) {
    fn.calls.push(args);
    fn.callCount += 1;
    if (fn._impl) return fn._impl.apply(this, args);
    return undefined;
  };
  fn.calls = [];
  fn.callCount = 0;
  fn._impl = null;
  return fn;
}

// Default mime type the design probes via isTypeSupported.
const DEFAULT_MIME = 'audio/webm;codecs=opus';

// User-visible error strings keyed by failure class. Matches design.md table.
function messageFor(kind, detail) {
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

function extFromMime(mime) {
  if (!mime) return 'bin';
  if (/^audio\/webm/.test(mime)) return 'webm';
  if (/^audio\/ogg/.test(mime)) return 'ogg';
  if (/^audio\/mp4/.test(mime)) return 'mp4';
  return 'bin';
}

// Mime-type pick — Req 1.2 / 1.3.
function pickRecorderMime(isTypeSupported) {
  if (isTypeSupported(DEFAULT_MIME)) {
    return { mimeType: DEFAULT_MIME, contentType: DEFAULT_MIME, filenameExt: 'webm' };
  }
  // Leave mimeType undefined; the recorder picks its own and we read it back
  // after construction to fill contentType + filenameExt.
  return { mimeType: undefined, contentType: undefined, filenameExt: undefined };
}


// ── Mock builders ───────────────────────────────────────────────────────────

// Build a minimal Blob-like object. We can't rely on a global Blob being
// present in plain Node, so we hand-roll one carrying the chunk's seq for
// inspection. The shape mirrors what tests need: `size` and an inspectable
// `seq` field. It is NOT a real Blob; the harness's mock FormData and fetch
// recorder accept it directly.
function makeBlob(seq, mimeType) {
  return {
    size: 1, // non-zero so enqueueChunk does not skip it
    type: mimeType || DEFAULT_MIME,
    seq,
    isMockBlob: true,
  };
}

// Tiny FormData shim. We keep entries in insertion order so tests can assert
// field shape without depending on a real DOM FormData.
function makeFormData() {
  const entries = [];
  return {
    isMockFormData: true,
    append(name, value, filename) {
      entries.push({ name, value, filename });
    },
    get(name) {
      const e = entries.find(x => x.name === name);
      return e ? e.value : null;
    },
    entries() { return entries.slice(); },
  };
}

// Build the localStorage shim.
function makeLocalStorage(initial) {
  const store = new Map();
  if (initial && typeof initial === 'object') {
    for (const k of Object.keys(initial)) store.set(k, String(initial[k]));
  }
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
    key(i) { return Array.from(store.keys())[i] ?? null; },
    get length() { return store.size; },
  };
}

// Build the MediaRecorder mock + factory. The constructor records the
// `mimeType` arg; `start()` / `stop()` are spies; `stop()` synchronously
// fires `ondataavailable` once with a small Blob carrying the chunk's seq.
function makeMediaRecorderMock(state) {
  // state.recorderInstances is the list of every constructed recorder so the
  // harness can flush the active one on rotate / stop.
  function MediaRecorder(stream, opts) {
    const inst = {
      stream,
      mimeType: (opts && opts.mimeType) ? opts.mimeType : DEFAULT_MIME,
      ondataavailable: null,
      state: 'inactive',
      start: makeSpy(),
      stop: makeSpy(),
      _seqOnNextStop: null, // assigned by the harness right before stop()
    };
    inst.start._impl = function () { inst.state = 'recording'; };
    inst.stop._impl = function () {
      if (inst.state === 'inactive') return;
      inst.state = 'inactive';
      // Synchronous ondataavailable fire — this is the harness's contract,
      // not the real browser behavior. Tests rely on this to be deterministic.
      const seq = inst._seqOnNextStop;
      inst._seqOnNextStop = null;
      if (typeof inst.ondataavailable === 'function') {
        const blob = makeBlob(seq != null ? seq : -1, inst.mimeType);
        inst.ondataavailable({ data: blob });
      }
    };
    state.recorderInstances.push(inst);
    return inst;
  }
  MediaRecorder.isTypeSupported = function (type) {
    return state.isTypeSupported(type);
  };
  return MediaRecorder;
}


// ── Harness entry point ─────────────────────────────────────────────────────

/**
 * Build a Whisper test harness.
 *
 * @param {object} [opts]
 * @param {string} [opts.platform='darwin'] — value of L.platform
 * @param {(type:string)=>boolean} [opts.isTypeSupported] — overrides the
 *        default `MediaRecorder.isTypeSupported` behavior. Default: returns
 *        true only for 'audio/webm;codecs=opus'.
 * @param {object} [opts.localStorage] — initial localStorage entries
 *        (e.g. { 'lumen.key.groq': 'gsk_xxx', 'lumen.whisper.chunkSeconds': '5' })
 * @param {object} [opts.getUserMedia] — config for the getUserMedia mock:
 *        { reject?: any, trackCount?: number }. Default resolves with a
 *        stream exposing two stop-spied tracks.
 * @param {number} [opts.trackCount=2] — number of mock tracks if not
 *        overridden by opts.getUserMedia.
 * @returns {object} harness
 */
function createWhisperHarness(opts) {
  const cfg = opts || {};

  // ── Mock state shared across the harness ──
  const state = {
    recorderInstances: [],
    isTypeSupported: typeof cfg.isTypeSupported === 'function'
      ? cfg.isTypeSupported
      : (type) => type === DEFAULT_MIME,
  };

  // localStorage shim
  const localStorageMock = makeLocalStorage(cfg.localStorage);

  // MediaRecorder mock
  const MediaRecorder = makeMediaRecorderMock(state);

  // navigator.mediaDevices.getUserMedia mock
  const getUserMediaSpy = makeSpy();
  const getUserMediaCfg = cfg.getUserMedia || {};
  const trackCount = (getUserMediaCfg.trackCount != null)
    ? getUserMediaCfg.trackCount
    : (cfg.trackCount != null ? cfg.trackCount : 2);
  getUserMediaSpy._impl = function (constraints) {
    if (getUserMediaCfg.reject !== undefined) {
      return Promise.reject(getUserMediaCfg.reject);
    }
    const tracks = [];
    for (let i = 0; i < trackCount; i++) {
      tracks.push({
        kind: 'audio',
        id: 'track-' + i,
        stop: makeSpy(),
      });
    }
    const stream = { getTracks: () => tracks.slice() };
    // hold a reference for getState() inspection
    stream._tracks = tracks;
    return Promise.resolve(stream);
  };

  // fetch mock — each call returns a Promise tied to a deferred so tests
  // can resolve responses in any order. Each call captures
  // { url, method, headers, body, seq } for assertion.
  const fetchCalls = [];
  const fetchDeferredsBySeq = new Map(); // seq → deferred
  const fetchSpy = function (url, init) {
    const seq = fetchSpy._nextSeq++;
    const deferred = createDeferred();
    fetchDeferredsBySeq.set(seq, deferred);
    fetchCalls.push({
      seq,
      url,
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {},
      body: init ? init.body : undefined,
    });
    fetchSpy.callCount += 1;
    return deferred.promise;
  };
  fetchSpy._nextSeq = 0;
  fetchSpy.callCount = 0;
  fetchSpy.calls = fetchCalls;

  // UI helper spies
  const setStatusSpy = makeSpy();
  const renderTranscriptSpy = makeSpy();
  const showTranscriptErrorSpy = makeSpy();
  const updateListenUISpy = makeSpy();
  const openMicPermsSpy = makeSpy();

  // L bridge
  const L = {
    platform: cfg.platform != null ? cfg.platform : 'darwin',
    openMicPerms: openMicPermsSpy,
  };


  // ── Whisper_Client state (mirrors design.md) ──
  let listening = false;
  let finalTranscript = '';
  let interimTranscript = '';
  let mediaStream = null;
  let mediaRecorder = null;
  let chunkSeq = 0;
  let nextAppendSeq = 0;
  const pendingTranscripts = new Map();
  let inFlight = 0;
  let stopped = false;
  let chunkRotateTimer = null; // simulated; the harness drives it via tickChunkInterval()
  let errored = false;
  let lastTranscriptError = null; // most recent message passed to showTranscriptError
  let lastStatus = null; // last [text, ok] pair passed to setStatus
  let recorderOpts = null; // captured at startWhisper

  // Map of fetch sequence → seq we assigned to the chunk that issued it.
  // Lets resolveFetch(chunkSeq, ...) find the right deferred.
  const fetchSeqByChunkSeq = new Map();

  // ── Config readers (Req 6.x) ──
  function readWhisperEndpoint() {
    const raw = localStorageMock.getItem('lumen.whisper.endpoint');
    if (raw == null || raw === '') return 'https://api.groq.com/openai/v1/audio/transcriptions';
    return raw;
  }
  function readWhisperModel() {
    const raw = localStorageMock.getItem('lumen.whisper.model');
    if (raw == null || raw === '') return 'whisper-large-v3';
    return raw;
  }
  function readChunkSeconds() {
    const raw = localStorageMock.getItem('lumen.whisper.chunkSeconds');
    if (raw == null || raw === '') return 5;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 5;
    if (!Number.isInteger(n)) return 5;
    if (n < 1 || n > 30) return 5;
    return n;
  }
  function readGroqKey() {
    const raw = localStorageMock.getItem('lumen.key.groq');
    return raw == null ? '' : String(raw);
  }

  // ── UI helper wrappers (route through spies + record state) ──
  function setStatus(text, ok) {
    lastStatus = [text, !!ok];
    setStatusSpy(text, ok);
  }
  function renderTranscript() { renderTranscriptSpy(finalTranscript, interimTranscript); }
  function showTranscriptError(message) {
    lastTranscriptError = message;
    showTranscriptErrorSpy(message);
  }
  function updateListenUI() { updateListenUISpy(listening); }

  // ── Status-line driver (Req 4.x) ──
  function updateStatusLine() {
    if (errored) return;
    if (listening) {
      if (inFlight > 0) setStatus('transcribing…', true);
      else setStatus('listening…', true);
    } else {
      setStatus('listening stopped', false);
    }
  }

  // ── ondataavailable callback wired into every constructed recorder ──
  function onDataAvailable(e) {
    enqueueChunk(e.data);
  }

  // ── Capture lifecycle (Req 1, 2.1, 2.6) ──
  async function startWhisper() {
    let stream;
    try {
      stream = await getUserMediaSpy({ audio: true });
    } catch (e) {
      reportError('mic-denied', e);
      return;
    }
    mediaStream = stream;

    // Reset session state.
    chunkSeq = 0;
    nextAppendSeq = 0;
    pendingTranscripts.clear();
    inFlight = 0;
    stopped = false;
    errored = false;
    fetchSeqByChunkSeq.clear();

    const pick = pickRecorderMime(state.isTypeSupported);
    recorderOpts = pick.mimeType ? { mimeType: pick.mimeType } : {};

    mediaRecorder = new MediaRecorder(mediaStream, recorderOpts);
    mediaRecorder.ondataavailable = onDataAvailable;
    mediaRecorder.start();

    // Simulated rotate timer — the harness's tickChunkInterval() drives it.
    chunkRotateTimer = { intervalMs: readChunkSeconds() * 1000 };

    listening = true;
    updateListenUI();
    updateStatusLine();
  }

  function rotateRecorder() {
    if (!listening || errored) return;
    // Tag the active recorder with the seq it's about to flush via stop().
    if (mediaRecorder) {
      mediaRecorder._seqOnNextStop = chunkSeq;
      try { mediaRecorder.stop(); } catch (e) { /* ignore */ }
    }
    mediaRecorder = new MediaRecorder(mediaStream, recorderOpts);
    mediaRecorder.ondataavailable = onDataAvailable;
    mediaRecorder.start();
  }

  function stopWhisper() {
    stopped = true;
    if (chunkRotateTimer) chunkRotateTimer = null;
    if (mediaRecorder) {
      // Trailing chunk (Req 2.6).
      mediaRecorder._seqOnNextStop = chunkSeq;
      try { mediaRecorder.stop(); } catch (e) { /* ignore */ }
    }
    if (mediaStream) {
      try { mediaStream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
    }
    listening = false;
    updateListenUI();
    updateStatusLine();
  }


  // ── Chunk pipeline (Req 2.x) ──
  function enqueueChunk(blob) {
    if (!blob || blob.size === 0) return;
    const seq = chunkSeq++;
    inFlight += 1;
    updateStatusLine();
    // Fire-and-forget; postChunk decrements inFlight when the deferred settles.
    postChunk(seq, blob);
  }

  function postChunk(seq, blob) {
    const form = makeFormData();
    const ext = extFromMime(blob.type);
    form.append('file', blob, 'chunk-' + seq + '.' + ext);
    form.append('model', readWhisperModel());
    form.append('response_format', 'json');

    const fetchPromise = fetchSpy(readWhisperEndpoint(), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + readGroqKey() },
      body: form,
    });
    // The fetch we just issued got an internal seq from fetchSpy. The most
    // recent call is at the end of fetchCalls.
    const lastCall = fetchCalls[fetchCalls.length - 1];
    fetchSeqByChunkSeq.set(seq, lastCall.seq);

    return fetchPromise.then(
      function (res) {
        if (!res || typeof res.ok !== 'boolean') {
          // Treat as malformed.
          finishInFlight();
          if (!errored) reportError('malformed-json', { reason: 'no-response' });
          return;
        }
        if (!res.ok) {
          finishInFlight();
          if (errored) return;
          // body may be a string already, or an awaitable text() function.
          let bodyText = '';
          if (typeof res.body === 'string') bodyText = res.body;
          else if (typeof res.text === 'function') {
            // The harness does not await text() asynchronously here; tests
            // that need a body should pass `body` directly. We still tolerate
            // a sync return for simplicity.
            try { bodyText = String(res.text()); } catch (e) { bodyText = ''; }
          }
          reportError('http-non-2xx', { status: res.status, body: bodyText.slice(0, 300) });
          return;
        }
        // 2xx — extract { text } from json. Accept either a parsed object on
        // res.json (the harness's resolveFetch sets this directly) or a
        // function that returns one.
        let parsed;
        try {
          if (res.json && typeof res.json === 'function') parsed = res.json();
          else parsed = res.json;
        } catch (e) {
          finishInFlight();
          if (!errored) reportError('malformed-json', e);
          return;
        }
        if (parsed == null || typeof parsed !== 'object' || typeof parsed.text !== 'string') {
          finishInFlight();
          if (!errored) reportError('malformed-json', { reason: 'no-text-field' });
          return;
        }
        // Success — store and drain.
        if (!errored) {
          pendingTranscripts.set(seq, { ok: true, text: String(parsed.text).trim() });
          drainAppendQueue();
        }
        finishInFlight();
      },
      function (err) {
        finishInFlight();
        if (!errored) reportError('fetch-network-error', err);
      },
    );
  }

  function finishInFlight() {
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

  // ── Error funnel (Req 3.x) ──
  function reportError(kind, detail) {
    if (errored) return;
    errored = true;
    const message = messageFor(kind, detail);
    showTranscriptError(message);
    setStatus('mic stopped due to error', false);
    if (kind === 'mic-denied' && L.platform === 'darwin') {
      try { L.openMicPerms(); } catch (e) { /* ignore */ }
    }
    // Tear down without re-entering reportError.
    stopped = true;
    if (chunkRotateTimer) chunkRotateTimer = null;
    if (mediaRecorder) {
      try { mediaRecorder.stop(); } catch (e) { /* ignore */ }
    }
    if (mediaStream) {
      try { mediaStream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
    }
    listening = false;
    updateListenUI();
  }

  // ── Public toggleListen (Req 3.1, 5.1, 7.1) ──
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


  // ── Test-facing helpers ──

  // Advance the rotate-timer one tick: the design says the timer fires
  // setInterval(rotateRecorder, chunkSeconds*1000). The harness simulates one
  // tick. No-op when not listening.
  function tickChunkInterval() {
    if (!listening || errored) return;
    rotateRecorder();
  }

  // Resolve the in-flight fetch issued for a given chunk seq with a
  // Response-like object. Tests can pass:
  //   { ok: true, status: 200, json: { text: '...' } }
  //   { ok: false, status: 500, body: '...' }
  function resolveFetch(seq, response) {
    const fetchSeq = fetchSeqByChunkSeq.get(seq);
    if (fetchSeq == null) {
      throw new Error('No in-flight fetch for chunk seq ' + seq);
    }
    const deferred = fetchDeferredsBySeq.get(fetchSeq);
    if (!deferred) {
      throw new Error('No deferred for fetch seq ' + fetchSeq);
    }
    fetchDeferredsBySeq.delete(fetchSeq);
    deferred.resolve(response);
    return deferred.promise;
  }

  // Reject the in-flight fetch issued for a given chunk seq with an error.
  function rejectFetch(seq, error) {
    const fetchSeq = fetchSeqByChunkSeq.get(seq);
    if (fetchSeq == null) {
      throw new Error('No in-flight fetch for chunk seq ' + seq);
    }
    const deferred = fetchDeferredsBySeq.get(fetchSeq);
    if (!deferred) {
      throw new Error('No deferred for fetch seq ' + fetchSeq);
    }
    fetchDeferredsBySeq.delete(fetchSeq);
    deferred.reject(error);
    return deferred.promise.catch(() => {});
  }

  // Inspect the harness state. Useful for property tests that want a single
  // snapshot to assert against.
  function getState() {
    return {
      listening,
      finalTranscript,
      interimTranscript,
      mediaStream,
      mediaRecorder,
      chunkSeq,
      nextAppendSeq,
      pendingTranscripts: Array.from(pendingTranscripts.entries()),
      inFlight,
      errored,
      stopped,
      lastStatus,
      lastTranscriptError,
      // raw call records / counters
      fetchCalls: fetchCalls.slice(),
      openMicPermsCalls: openMicPermsSpy.callCount,
      updateListenUICalls: updateListenUISpy.callCount,
      renderTranscriptCalls: renderTranscriptSpy.callCount,
      showTranscriptErrorCalls: showTranscriptErrorSpy.callCount,
      setStatusCalls: setStatusSpy.callCount,
      getUserMediaCalls: getUserMediaSpy.callCount,
      trackStopCalls: countTrackStops(),
      recorderStartCalls: countRecorderStarts(),
      recorderStopCalls: countRecorderStops(),
      recorderInstances: state.recorderInstances.slice(),
      chunkRotateTimer,
    };
  }

  function countTrackStops() {
    if (!mediaStream || !mediaStream._tracks) return 0;
    return mediaStream._tracks.reduce((acc, t) => acc + (t.stop && t.stop.callCount ? t.stop.callCount : 0), 0);
  }
  function countRecorderStarts() {
    return state.recorderInstances.reduce((acc, r) => acc + r.start.callCount, 0);
  }
  function countRecorderStops() {
    return state.recorderInstances.reduce((acc, r) => acc + r.stop.callCount, 0);
  }

  // ── The harness object the tests interact with ──
  const harness = {
    // Drive the state machine
    toggleListen,
    tickChunkInterval,
    resolveFetch,
    rejectFetch,

    // Inspect everything
    getState,

    // Pure config readers — exposed so property tests can drive them
    // through the harness's localStorage shim without spinning up the
    // full lifecycle. The test sets `harness.mocks.localStorage` (or
    // passes `localStorage` to the constructor) and reads back via
    // these accessors. Mirrors Req 6.1, 6.2, 6.3, 6.4, 6.5.
    readWhisperEndpoint,
    readWhisperModel,
    readChunkSeconds,
    readGroqKey,

    // Convenience getters (mirror the previous recognitionHarness pattern)
    get startCalls() { return countRecorderStarts(); },
    get postCalls() { return fetchSpy.callCount; },
    get transcriptText() { return finalTranscript; },
    get inFlight() { return inFlight; },
    get listening() { return listening; },
    get errored() { return errored; },
    get lastStatus() { return lastStatus; },
    get lastTranscriptError() { return lastTranscriptError; },
    get fetchCalls() { return fetchCalls.slice(); },
    get recorderInstances() { return state.recorderInstances.slice(); },

    // Direct access to the mocks for advanced assertions
    mocks: {
      getUserMedia: getUserMediaSpy,
      MediaRecorder,
      fetch: fetchSpy,
      localStorage: localStorageMock,
      setStatus: setStatusSpy,
      renderTranscript: renderTranscriptSpy,
      showTranscriptError: showTranscriptErrorSpy,
      updateListenUI: updateListenUISpy,
      openMicPerms: openMicPermsSpy,
      L,
    },

    // Configuration knobs the tests can flip mid-test
    setIsTypeSupported(fn) { state.isTypeSupported = fn; },
    setPlatform(p) { L.platform = p; },
  };

  return harness;
}

module.exports = {
  createWhisperHarness,
  // exported for unit tests that want to exercise pure helpers in isolation
  pickRecorderMime,
  messageFor,
  extFromMime,
  DEFAULT_MIME,
};
