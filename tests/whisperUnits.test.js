// whisperUnits.test.js — example/unit tests for the Whisper_Client
// covering the example-classified acceptance criteria from
// .kiro/specs/whisper-mic-transcription/design.md (tasks 10.1 – 10.7).
//
// These tests complement tests/whisperPbt.test.js (which carries the
// universally-quantified property tests). Each describe block below maps
// 1:1 onto a sub-task in tasks.md task 10.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWhisperHarness } from './whisperHarness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RENDERER_PATH = resolve(__dirname, '../renderer/renderer.js');

// ─── 10.1 — capture and permission ──────────────────────────────────────────
describe('10.1 — capture and permission', () => {
  it('1.1: getUserMedia is invoked with { audio: true } on start', async () => {
    const harness = createWhisperHarness({ localStorage: { 'lumen.key.groq': 'gsk_x' } });
    await harness.toggleListen();
    expect(harness.mocks.getUserMedia.calls.length).toBe(1);
    expect(harness.mocks.getUserMedia.calls[0][0]).toEqual({ audio: true });
  });

  it('1.2: opus-supported → recorder constructed with audio/webm;codecs=opus', async () => {
    const harness = createWhisperHarness({
      localStorage: { 'lumen.key.groq': 'gsk_x' },
      isTypeSupported: () => true,
    });
    await harness.toggleListen();
    const rec = harness.recorderInstances[0];
    expect(rec).toBeTruthy();
    expect(rec.mimeType).toBe('audio/webm;codecs=opus');
  });

  it('1.3: opus-NOT-supported → FormData blob carries recorder.mimeType', async () => {
    const harness = createWhisperHarness({
      localStorage: { 'lumen.key.groq': 'gsk_x' },
      isTypeSupported: () => false,
    });
    await harness.toggleListen();
    const rec = harness.recorderInstances[0];
    // The recorder always reports a non-empty mimeType after construction —
    // either the one we asked for, or the one the implementation defaulted to.
    expect(rec.mimeType).toBeTruthy();

    // Drive one chunk through the pipeline; the FormData blob's Content-Type
    // (its `type` field) must equal the recorder's reported mimeType.
    harness.tickChunkInterval();
    await Promise.resolve();
    const lastFetch = harness.fetchCalls[harness.fetchCalls.length - 1];
    const form = lastFetch.body;
    const fileEntry = form.entries().find(e => e.name === 'file');
    expect(fileEntry).toBeTruthy();
    expect(fileEntry.value.type).toBe(rec.mimeType);
  });

  it('1.4: stop click stops recorder and every track on the stream', async () => {
    const harness = createWhisperHarness({
      localStorage: { 'lumen.key.groq': 'gsk_x' },
      trackCount: 3,
    });
    await harness.toggleListen();
    const before = harness.getState();
    expect(before.recorderStopCalls).toBe(0);
    expect(before.trackStopCalls).toBe(0);

    await harness.toggleListen(); // stop
    const state = harness.getState();
    expect(state.recorderStopCalls).toBeGreaterThanOrEqual(1);
    expect(state.trackStopCalls).toBe(3);
  });

  it('1.5: a getUserMedia rejection renders exactly one transcript error', async () => {
    const harness = createWhisperHarness({
      localStorage: { 'lumen.key.groq': 'gsk_x' },
      getUserMedia: { reject: new Error('NotAllowedError') },
    });
    await harness.toggleListen();
    const state = harness.getState();
    expect(state.showTranscriptErrorCalls).toBe(1);
    expect(state.errored).toBe(true);
    expect(state.listening).toBe(false);
  });

  it('1.6: getUserMedia rejection on darwin invokes openMicPerms; on linux it does not', async () => {
    const darwin = createWhisperHarness({
      localStorage: { 'lumen.key.groq': 'gsk_x' },
      getUserMedia: { reject: new Error('NotAllowedError') },
      platform: 'darwin',
    });
    await darwin.toggleListen();
    expect(darwin.mocks.openMicPerms.callCount).toBe(1);

    const linux = createWhisperHarness({
      localStorage: { 'lumen.key.groq': 'gsk_x' },
      getUserMedia: { reject: new Error('NotAllowedError') },
      platform: 'linux',
    });
    await linux.toggleListen();
    expect(linux.mocks.openMicPerms.callCount).toBe(0);
  });
});

// ─── 10.2 — chunk cadence and POST shape ────────────────────────────────────
describe('10.2 — chunk cadence and POST shape', () => {
  it('2.1: three rotate ticks while listening produce three enqueueChunk emissions', async () => {
    // NOTE: The harness's chunkRotateTimer is simulated (not a real
    // setInterval). The harness exposes tickChunkInterval() as the public
    // way to drive rotations, so this test ticks 3 times instead of using
    // vi.useFakeTimers().
    const harness = createWhisperHarness({ localStorage: { 'lumen.key.groq': 'gsk_x' } });
    await harness.toggleListen();
    const before = harness.fetchCalls.length;
    harness.tickChunkInterval();
    harness.tickChunkInterval();
    harness.tickChunkInterval();
    await Promise.resolve();
    const after = harness.fetchCalls.length;
    expect(after - before).toBe(3);
  });

  it('2.2: the captured fetch body is FormData with file, model, response_format=json', async () => {
    const harness = createWhisperHarness({
      localStorage: {
        'lumen.key.groq': 'gsk_x',
        'lumen.whisper.model': 'whisper-large-v3',
      },
    });
    await harness.toggleListen();
    harness.tickChunkInterval();
    await Promise.resolve();
    const lastFetch = harness.fetchCalls[harness.fetchCalls.length - 1];
    const form = lastFetch.body;
    expect(form.isMockFormData).toBe(true);

    const entries = form.entries();
    const fileEntry = entries.find(e => e.name === 'file');
    const modelEntry = entries.find(e => e.name === 'model');
    const formatEntry = entries.find(e => e.name === 'response_format');
    expect(fileEntry).toBeTruthy();
    expect(fileEntry.value.isMockBlob).toBe(true);
    expect(modelEntry).toBeTruthy();
    expect(modelEntry.value).toBe('whisper-large-v3');
    expect(formatEntry).toBeTruthy();
    expect(formatEntry.value).toBe('json');
  });

  it('2.3: the captured fetch headers include Authorization: Bearer <key>', async () => {
    const harness = createWhisperHarness({
      localStorage: { 'lumen.key.groq': 'gsk_test_value_xyz' },
    });
    await harness.toggleListen();
    harness.tickChunkInterval();
    await Promise.resolve();
    const lastFetch = harness.fetchCalls[harness.fetchCalls.length - 1];
    expect(lastFetch.headers).toBeTruthy();
    expect(lastFetch.headers.Authorization).toBe('Bearer gsk_test_value_xyz');
  });

  it('2.6: toggleListen while listening flips listening synchronously and emits a trailing chunk', async () => {
    const harness = createWhisperHarness({ localStorage: { 'lumen.key.groq': 'gsk_x' } });
    await harness.toggleListen();
    expect(harness.listening).toBe(true);

    const fetchesBeforeStop = harness.fetchCalls.length;
    // Kick off the stop without awaiting first — `listening` should flip
    // synchronously inside the (sync) stopWhisper body.
    const stopPromise = harness.toggleListen();
    expect(harness.listening).toBe(false);
    await stopPromise;

    // The recorder.stop() call from stopWhisper fires ondataavailable
    // → enqueueChunk → postChunk → fetch, all synchronously inside the
    // mock. So at least one new fetch should have been issued (the
    // trailing chunk required by Req 2.6).
    expect(harness.fetchCalls.length).toBeGreaterThanOrEqual(fetchesBeforeStop + 1);
  });
});

// ─── 10.3 — error message body ──────────────────────────────────────────────
describe('10.3 — error message body', () => {
  it('3.3: HTTP non-2xx error message contains status code and first 300 chars of body', async () => {
    const harness = createWhisperHarness({ localStorage: { 'lumen.key.groq': 'gsk_x' } });
    await harness.toggleListen();
    harness.tickChunkInterval();
    await Promise.resolve();

    const longBody = 'x'.repeat(500);
    harness.resolveFetch(0, { ok: false, status: 503, body: longBody });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const state = harness.getState();
    expect(state.lastTranscriptError).toBeTruthy();
    expect(state.lastTranscriptError).toContain('503');
    // Body must be sliced to exactly 300 chars.
    expect(state.lastTranscriptError).toContain('x'.repeat(300));
    expect(state.lastTranscriptError).not.toContain('x'.repeat(301));
  });

  it('3.4: malformed JSON path — both invalid-shape and missing-text produce the same error class', async () => {
    // Case A: 2xx body with no `text` field at all.
    const h1 = createWhisperHarness({ localStorage: { 'lumen.key.groq': 'gsk_x' } });
    await h1.toggleListen();
    h1.tickChunkInterval();
    await Promise.resolve();
    h1.resolveFetch(0, { ok: true, status: 200, json: { not_text: 'oops' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(h1.lastTranscriptError).toBeTruthy();
    expect(h1.lastTranscriptError).toContain('not valid JSON');

    // Case B: 2xx body that parses but isn't an object (e.g. a bare string).
    const h2 = createWhisperHarness({ localStorage: { 'lumen.key.groq': 'gsk_x' } });
    await h2.toggleListen();
    h2.tickChunkInterval();
    await Promise.resolve();
    h2.resolveFetch(0, { ok: true, status: 200, json: 'not an object' });
    await Promise.resolve();
    await Promise.resolve();
    expect(h2.lastTranscriptError).toBeTruthy();
    expect(h2.lastTranscriptError).toContain('not valid JSON');

    // Both paths route through the same user-visible error.
    expect(h1.lastTranscriptError).toBe(h2.lastTranscriptError);
  });
});

// ─── 10.4 — status-line edges ───────────────────────────────────────────────
describe('10.4 — status-line edges', () => {
  it('4.1: starting listening with no in-flight chunks yields setStatus(listening…, true)', async () => {
    const harness = createWhisperHarness({ localStorage: { 'lumen.key.groq': 'gsk_x' } });
    await harness.toggleListen();
    expect(harness.listening).toBe(true);
    expect(harness.errored).toBe(false);
    expect(harness.lastStatus).toEqual(['listening…', true]);
  });

  it('4.4: stopping listening with inFlight===0 and errored===false yields setStatus(listening stopped, false)', async () => {
    const harness = createWhisperHarness({ localStorage: { 'lumen.key.groq': 'gsk_x' } });
    await harness.toggleListen();
    await harness.toggleListen(); // stop — emits a trailing chunk (seq 0)

    // Resolve the trailing chunk so inFlight returns to 0.
    harness.resolveFetch(0, { ok: true, status: 200, json: { text: '' } });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.listening).toBe(false);
    expect(harness.errored).toBe(false);
    expect(harness.getState().inFlight).toBe(0);
    expect(harness.lastStatus).toEqual(['listening stopped', false]);
  });
});

// ─── 10.5 — prompt-injection helpers unchanged (structural source check) ────
describe('10.5 — prompt-injection helpers unchanged', () => {
  // NOTE: The harness doesn't model the prompt-injection buttons (those are
  // renderer DOM event handlers). This test reads the renderer.js source
  // and asserts that the three handler bodies still match the expected
  // pattern — a structural rather than behavioral check.
  // UPDATED: this test used to pin the handler bodies to the exact expression
  // `(finalTranscript + interimTranscript).trim()`. That shape is what forced
  // the transcript to be cleared by hand between questions, and it mixed both
  // speakers into the prompt, so the model answered the wrong half of the
  // conversation. The handlers now read through a cursor and default to the
  // "them" channel. The intent of the check is unchanged — Use, Append and
  // Clear must stay wired and must operate on the transcript state — so it is
  // asserted against the current contract rather than the old expression.
  it('5.3: renderer.js still wires Use/Append/Clear handlers over the transcript state', () => {
    const src = readFileSync(RENDERER_PATH, 'utf8');

    expect(src).toMatch(/transcriptUse\.addEventListener\(\s*'click'/);
    expect(src).toMatch(/transcriptAppend\.addEventListener\(\s*'click'/);
    expect(src).toMatch(/transcriptClear\.addEventListener\(\s*'click'/);

    // Use and Append both draw from the cursor-advancing reader, so the same
    // words are never taken twice and no manual clear is needed.
    expect(src).toMatch(/function takeLatest\(\)/);
    expect(src).toMatch(/input\.value\s*=\s*t;/);
    expect(src).toMatch(/input\.value\s*=\s*\(input\.value\s*\?\s*input\.value\s*\+\s*'\\n\\n'\s*:\s*''\)\s*\+\s*t/);

    // Clear still resets both strings, and now the cursor and entries too.
    expect(src).toMatch(/finalTranscript\s*=\s*'';\s*interimTranscript\s*=\s*'';\s*renderTranscript\(\)/);
    expect(src).toMatch(/transcriptCursor\s*=\s*0;/);
  });
});

// ─── 10.6 — configuration readers ───────────────────────────────────────────
describe('10.6 — configuration readers', () => {
  it('6.1: readWhisperEndpoint default and configured', () => {
    const def = createWhisperHarness({ localStorage: {} });
    expect(def.readWhisperEndpoint()).toBe('https://api.groq.com/openai/v1/audio/transcriptions');

    const cfg = createWhisperHarness({
      localStorage: { 'lumen.whisper.endpoint': 'https://my.example.com/whisper' },
    });
    expect(cfg.readWhisperEndpoint()).toBe('https://my.example.com/whisper');
  });

  it('6.2: readWhisperModel default and configured', () => {
    const def = createWhisperHarness({ localStorage: {} });
    expect(def.readWhisperModel()).toBe('whisper-large-v3');

    const cfg = createWhisperHarness({
      localStorage: { 'lumen.whisper.model': 'whisper-medium-en' },
    });
    expect(cfg.readWhisperModel()).toBe('whisper-medium-en');
  });

  it('6.5: readGroqKey reads lumen.key.groq directly, ignoring any other backend keys', () => {
    // NOTE: The harness doesn't model `backendSel`. This test asserts that
    // readGroqKey() reads from the `lumen.key.groq` localStorage key
    // directly, regardless of any other localStorage state. Per design.md,
    // the renderer's readGroqKey reads localStorage.getItem('lumen.key.groq')
    // directly (NOT via currentKey()) so it works regardless of which chat
    // backend the user has selected.
    const harness = createWhisperHarness({
      localStorage: {
        'lumen.key.groq': 'gsk_correct',
        'lumen.key.gemini': 'AIza_other',
        'lumen.backend': 'gemini',
      },
    });
    expect(harness.readGroqKey()).toBe('gsk_correct');

    // And when the key is absent, it returns the empty string, not whatever
    // is under another backend's key.
    const harnessNoGroq = createWhisperHarness({
      localStorage: {
        'lumen.key.gemini': 'AIza_other',
        'lumen.backend': 'gemini',
      },
    });
    expect(harnessNoGroq.readGroqKey()).toBe('');
  });
});

// ─── 10.7 — Web Speech identifiers retired from renderer.js ────────────────
describe('10.7 — Web Speech identifiers retired from renderer.js', () => {
  it('7.3: zero matches for SpeechRecognition / webkitSpeechRecognition / MAX_ERROR_RESTARTS / MIN_CLEAN_SESSION_MS / consecutiveErrorRestarts / lastSessionStartedAt / lastError', () => {
    const src = readFileSync(RENDERER_PATH, 'utf8');

    const banned = [
      'SpeechRecognition',
      'webkitSpeechRecognition',
      'MAX_ERROR_RESTARTS',
      'MIN_CLEAN_SESSION_MS',
      'consecutiveErrorRestarts',
      'lastSessionStartedAt',
    ];
    for (const id of banned) {
      expect(src, `renderer.js still references retired identifier "${id}"`).not.toContain(id);
    }

    // `lastError` is checked with a word boundary because renderer.js may
    // legitimately mention unrelated `error` identifiers; we only forbid the
    // exact retired identifier name.
    expect(src, 'renderer.js still references retired identifier "lastError"').not.toMatch(/\blastError\b/);
  });
});
