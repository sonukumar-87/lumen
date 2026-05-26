# Implementation Plan: Whisper Mic Transcription

Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

## Overview

This plan replaces the renderer's Web Speech mic transcription with a Whisper_Client that POSTs `MediaRecorder` chunks to Groq's `/v1/audio/transcriptions` endpoint. The change is renderer-only (`lumen/renderer/renderer.js`); `main.js` and `preload.js` are untouched. The work proceeds in three layers:

1. **Test scaffolding** — retire the Web Speech harness and tests from the previous bugfix; add a new `tests/whisperHarness.js` that mocks `MediaRecorder`, `getUserMedia`, `fetch`, `localStorage`, and the renderer's UI helpers.
2. **Whisper_Client implementation** — config readers, state, capture lifecycle (`startWhisper` / `stopWhisper` / `rotateRecorder`), chunk pipeline (`enqueueChunk` / `postChunk` / `drainAppendQueue`), error funnel (`reportError`), and status-line driver (`updateStatusLine`).
3. **Wiring + retirement** — replace `toggleListen`'s body, remove `setupRecognition` and the five Web Speech state names, then a unit-test sweep over the example-classified acceptance criteria plus a source-grep guard.

Property tests (`tests/whisperPbt.test.js`) live next to the implementation they validate so failures surface early. Unit tests (`tests/whisperUnits.test.js`) batch the example-classified criteria from the design's prework and run after the wiring is complete.

## Tasks

- [x] 1. Retire Web Speech test scaffolding
  - [x] 1.1 Delete obsolete Web Speech tests
    - Delete `lumen/tests/recognitionHarness.js`
    - Delete `lumen/tests/bug-condition.test.js`
    - Delete `lumen/tests/preservation.test.js`
    - These exercise the previous bugfix's restart-policy state and Web Speech event handlers, both of which are removed by this feature
    - _Requirements: 7.1, 7.3_

- [x] 2. Build the Whisper test harness
  - [x] 2.1 Create `lumen/tests/whisperHarness.js`
    - Mock `navigator.mediaDevices.getUserMedia` (returns a `MediaStream`-shaped object whose `getTracks()` exposes N mock tracks each with a `stop` spy)
    - Mock `MediaRecorder` (constructor records the `mimeType` arg; `start` / `stop` are spies; `stop()` synchronously fires `ondataavailable` once with a small `Blob` carrying the chunk's `seq`)
    - Mock `MediaRecorder.isTypeSupported` (configurable per test)
    - Mock `fetch` so each call returns a `Promise` exposed via a deferred (lets the test resolve responses in any order)
    - Mock `localStorage` (`Map`-backed shim)
    - Mock `setStatus`, `renderTranscript`, `showTranscriptError`, `updateListenUI`, and `L.openMicPerms` as spies
    - Expose `harness.toggleListen()`, `harness.tickChunkInterval()`, `harness.resolveFetch(seq, response)`, `harness.rejectFetch(seq, error)`, `harness.getState()`, plus counters (`startCalls`, `postCalls`, `transcriptText`, `inFlight`, `lastStatus`, `lastTranscriptError`, `errored`)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4_

- [x] 3. Add Whisper configuration readers in `lumen/renderer/renderer.js`
  - [x] 3.1 Implement `readWhisperEndpoint`, `readWhisperModel`, `readChunkSeconds`, `readGroqKey`
    - `readWhisperEndpoint`: read `localStorage.getItem('lumen.whisper.endpoint')`; treat `null` or `''` as default `https://api.groq.com/openai/v1/audio/transcriptions`
    - `readWhisperModel`: read `localStorage.getItem('lumen.whisper.model')`; treat `null` or `''` as default `whisper-large-v3`
    - `readChunkSeconds`: read `localStorage.getItem('lumen.whisper.chunkSeconds')`; coerce via `Number(...)`; treat absent / empty / non-finite / non-integer / outside `[1,30]` as default `5`
    - `readGroqKey`: read `localStorage.getItem('lumen.key.groq')` directly (NOT via `currentKey()`), so the value is independent of the currently selected chat backend
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x]* 3.2 Write property test for `readChunkSeconds` validator
    - **Property 4: `readChunkSeconds` is a sound validator**
    - **Validates: Requirements 6.3, 6.4**
    - In `lumen/tests/whisperPbt.test.js`, drive arbitrary `string | null` inputs (including `''`, `'0'`, `'0.5'`, `'31'`, `'-1'`, `'abc'`, decimal strings, surrounding whitespace, large numbers) through the harness's `localStorage` shim and assert `readChunkSeconds()` returns either the parsed integer when it lies in `[1,30]` or `5` in every other case
    - Run ≥100 fast-check iterations

- [x] 4. Replace Web Speech state with Whisper_Client state
  - [x] 4.1 Swap module-scoped state in `lumen/renderer/renderer.js`
    - Add: `let mediaStream = null;`, `let mediaRecorder = null;`, `let chunkSeq = 0;`, `let nextAppendSeq = 0;`, `const pendingTranscripts = new Map();`, `let inFlight = 0;`, `let stopped = false;`, `let chunkRotateTimer = null;`, `let errored = false;`
    - Keep: `let listening = false;`, `let finalTranscript = '';`, `let interimTranscript = '';`
    - Remove: `let recognition = null;`, `const MAX_ERROR_RESTARTS = 3;`, `const MIN_CLEAN_SESSION_MS = 1000;`, `let consecutiveErrorRestarts = 0;`, `let lastSessionStartedAt = 0;`, `let lastError = null;`
    - _Requirements: 7.3_

- [x] 5. Implement the Whisper capture lifecycle
  - [x] 5.1 Implement `pickRecorderMime` in `lumen/renderer/renderer.js`
    - Returns `{ mimeType, contentType, filenameExt }`
    - When `MediaRecorder.isTypeSupported('audio/webm;codecs=opus')` is `true`: prefer `audio/webm;codecs=opus` and `.webm`
    - Otherwise: leave `mimeType` undefined for the recorder, then read the recorder's reported `mimeType` after construction and use it as the FormData blob's `Content-Type` (`.ogg` for `audio/ogg`, `.mp4` for `audio/mp4`, fallback `.bin`)
    - _Requirements: 1.2, 1.3_

  - [x] 5.2 Implement `startWhisper`, `stopWhisper`, `rotateRecorder` in `lumen/renderer/renderer.js`
    - `startWhisper`: `await navigator.mediaDevices.getUserMedia({ audio: true })`; on rejection call `reportError('mic-denied', e)`. On success: store `mediaStream`; instantiate `mediaRecorder = new MediaRecorder(mediaStream, recorderOpts)`; wire `ondataavailable → enqueueChunk(e.data)`; `mediaRecorder.start()` with NO timeslice; `chunkRotateTimer = setInterval(rotateRecorder, readChunkSeconds() * 1000)`; set `listening = true`, `errored = false`, `chunkSeq = 0`, `nextAppendSeq = 0`, `inFlight = 0`, `stopped = false`, `pendingTranscripts.clear()`; `updateListenUI()`; `setStatus('listening…', true)`
    - `stopWhisper`: set `stopped = true`; `clearInterval(chunkRotateTimer)` and null it; `try { mediaRecorder.stop() } catch {}` (flushes the trailing chunk via the existing `ondataavailable`); `mediaStream?.getTracks().forEach(t => t.stop())`; `listening = false`; `updateListenUI()`; call `updateStatusLine()` so the status text reflects the new state
    - `rotateRecorder`: short-circuit when `!listening || errored`; `try { mediaRecorder.stop() } catch {}` then `mediaRecorder = new MediaRecorder(mediaStream, recorderOpts); mediaRecorder.ondataavailable = onDataAvailable; mediaRecorder.start()` (rotate-the-recorder strategy from design, NOT `start(timeslice)`)
    - _Requirements: 1.1, 1.4, 2.1, 2.6_

- [x] 6. Implement the Whisper chunk pipeline
  - [x] 6.1 Implement `enqueueChunk`, `postChunk`, `drainAppendQueue` in `lumen/renderer/renderer.js`
    - `enqueueChunk(blob)`: skip when `blob.size === 0`; `const seq = chunkSeq++`; `inFlight++`; call `updateStatusLine()`; fire-and-forget `postChunk(seq, blob)`
    - `postChunk(seq, blob)`: build `FormData` with `file` (the blob, named `chunk-<seq>.<ext>`), `model = readWhisperModel()`, `response_format = 'json'`; `await fetch(readWhisperEndpoint(), { method: 'POST', headers: { Authorization: 'Bearer ' + readGroqKey() }, body: form })`. On thrown error → `reportError('fetch-network-error', e)`. On `!res.ok` → `reportError('http-non-2xx', { status: res.status, body: (await res.text()).slice(0, 300) })`. On `res.ok`: parse via `await res.json()`; on parse failure or missing string `text` → `reportError('malformed-json', ...)`. On success: `pendingTranscripts.set(seq, { ok: true, text: String(text).trim() })` then `drainAppendQueue()`. In all paths: `inFlight--; updateStatusLine()`. Skip the success-path append when `errored` is already set
    - `drainAppendQueue()`: loop while `pendingTranscripts.has(nextAppendSeq)`: pop the entry, advance `nextAppendSeq`, and if `entry.ok && entry.text` then `finalTranscript += (finalTranscript ? ' ' : '') + entry.text; renderTranscript()`
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.7_

  - [x]* 6.2 Write property test for emission-order append
    - **Property 1: Transcripts are appended in chunk-emission order**
    - **Validates: Requirements 2.4, 2.5, 2.7, 5.4**
    - In `lumen/tests/whisperPbt.test.js`, generate `N ∈ [1,8]` chunks with arbitrary trimmed / whitespace / empty texts and an arbitrary permutation of response-arrival order (drive via `harness.resolveFetch(seq, response)` in the permuted order)
    - After all responses resolve, assert `harness.transcriptText` equals the concatenation (in emission order, single-space separated) of `text.trim()` over only those chunks where `text.trim()` is non-empty, AND `renderTranscript` was invoked at least once for every contributing chunk
    - Run ≥100 fast-check iterations

- [x] 7. Implement the error funnel and status-line driver
  - [x] 7.1 Implement `reportError(kind, detail)` in `lumen/renderer/renderer.js`
    - Latch on `errored`: if already `true`, return immediately (exactly-one user-visible error per session)
    - Set `errored = true`
    - Pick the user-visible message per failure class table in `design.md` for `kind ∈ { 'missing-key', 'mic-denied', 'fetch-network-error', 'http-non-2xx', 'malformed-json' }`; for `http-non-2xx` interpolate `detail.status` and `detail.body` (already pre-sliced to 300 chars)
    - Call `showTranscriptError(message)`
    - Call `setStatus('mic stopped due to error', false)`
    - Call `stopWhisper()`
    - When `kind === 'mic-denied'` and `L.platform === 'darwin'`, also fire-and-forget `L.openMicPerms()`
    - _Requirements: 1.5, 1.6, 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 7.2 Implement `updateStatusLine` in `lumen/renderer/renderer.js`
    - When `errored` is `true`, return without updating (the error message must not be overwritten by a stale `'listening…'`)
    - Else when `listening === true`: `inFlight > 0` → `setStatus('transcribing…', true)`; otherwise → `setStatus('listening…', true)`
    - Else (listening just transitioned to `false` cleanly with no in-flight POST): `setStatus('listening stopped', false)`
    - Invoke from `enqueueChunk` (after `inFlight++`), from `postChunk` (after `inFlight--` on every resolution path), and from `stopWhisper` (after flipping `listening`)
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x]* 7.3 Write property test for the bounded-error funnel
    - **Property 2: A failure renders exactly one user-visible error and stops listening**
    - **Validates: Requirements 1.4, 3.1, 3.2, 3.3, 3.4, 3.5**
    - In `lumen/tests/whisperPbt.test.js`, generate failure class ∈ `{ 'missing-key', 'mic-denied', 'fetch-network-error', 'http-non-2xx', 'malformed-json' }` × prior in-flight count `∈ [0,8]` × failure timing (before, between, or after other resolutions)
    - Assert: `lastTranscriptError` set exactly once, `listening === false`, `updateListenUI` called at least once after the failure, `mediaRecorder.stop` was called, every mock track's `stop` was called, `chunkRotateTimer` was cleared, and no `fetch` is invoked for the current session after the failure-induced stop completes
    - Run ≥100 fast-check iterations

  - [x]* 7.4 Write property test for the status-line invariant
    - **Property 3: Status-line reflects in-flight count under listening**
    - **Validates: Requirements 4.1, 4.2, 4.3**
    - In `lumen/tests/whisperPbt.test.js`, generate arbitrary interleavings of chunk-start and chunk-end events (preserving the `inFlight ≥ 0` invariant) while `listening === true` and `errored === false`
    - After every event, assert the most recent `setStatus` call equals `('transcribing…', true)` when `inFlight > 0` and `('listening…', true)` when `inFlight === 0`
    - Run ≥100 fast-check iterations

- [x] 8. Wire Whisper into the listen button and retire `setupRecognition`
  - [x] 8.1 Replace `toggleListen` body in `lumen/renderer/renderer.js`
    - Function name `toggleListen` is reused so the existing `listenBtn.addEventListener('click', toggleListen)` line stays valid
    - When `listening === true`: call `stopWhisper()` and return
    - Otherwise: if `readGroqKey()` returns empty, call `reportError('missing-key')` and return without flipping `listening`; else `await startWhisper()` (which routes `getUserMedia` rejection through `reportError('mic-denied')`)
    - _Requirements: 3.1, 5.1, 7.1_

  - [x] 8.2 Remove `setupRecognition` and the Web Speech wiring in `lumen/renderer/renderer.js`
    - Delete `setupRecognition` and its `r.onresult` / `r.onerror` / `r.onend` handlers in their entirety
    - Replace the `// MIC LISTENING (Web Speech API)` preamble comment with a Whisper preamble describing the new flow
    - Replace `transcriptLang.textContent = '(' + (recognition?.lang || 'en-US') + ')';` inside `updateListenUI` with `transcriptLang.textContent = '';` (the lang panel is cosmetic)
    - Verify by source-grep that `SpeechRecognition`, `webkitSpeechRecognition`, `MAX_ERROR_RESTARTS`, `MIN_CLEAN_SESSION_MS`, `consecutiveErrorRestarts`, `lastSessionStartedAt`, `lastError` produce zero matches in `lumen/renderer/renderer.js`
    - _Requirements: 7.1, 7.2, 7.3_

- [x] 9. Checkpoint - Whisper pipeline complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Cover example-classified acceptance criteria with unit tests
  - [x]* 10.1 Capture and permission unit tests in `lumen/tests/whisperUnits.test.js`
    - 1.1: `getUserMedia` is invoked with `{ audio: true }` on start
    - 1.2: when `MediaRecorder.isTypeSupported('audio/webm;codecs=opus')` is `true`, the recorder is constructed with that mime type
    - 1.3: when `isTypeSupported` is `false`, the recorder is constructed with the default mime and the FormData blob's `Content-Type` carries `mediaRecorder.mimeType`
    - 1.4: stop click calls `recorder.stop` and `track.stop` for every track on `mediaStream.getTracks()`
    - 1.5: a `getUserMedia` rejection renders exactly one transcript error
    - 1.6: a `getUserMedia` rejection on `darwin` invokes `L.openMicPerms`; on `linux` it does not
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x]* 10.2 Chunk cadence and POST shape unit tests in `lumen/tests/whisperUnits.test.js`
    - 2.1: with `vi.useFakeTimers()`, advancing `3 × chunkSeconds × 1000` ms while listening produces three `enqueueChunk` emissions
    - 2.2: the captured `fetch` body is `FormData` with fields `file`, `model = readWhisperModel()`, `response_format = 'json'`
    - 2.3: the captured `fetch` headers include `Authorization: Bearer <readGroqKey()>`
    - 2.6: `toggleListen` while `listening === true` flips `listening` synchronously to `false` AND emits a trailing chunk (the recorder's final `ondataavailable`)
    - _Requirements: 2.1, 2.2, 2.3, 2.6_

  - [x]* 10.3 Error message body unit tests in `lumen/tests/whisperUnits.test.js`
    - 3.3: an HTTP non-2xx response produces a `showTranscriptError` whose text contains the status code and the first 300 chars of the response body
    - 3.4: both an invalid-JSON body and a 2xx body that lacks a string `text` field route through `reportError('malformed-json', ...)` and produce the malformed-JSON user-visible error
    - _Requirements: 3.3, 3.4_

  - [x]* 10.4 Status-line edge unit tests in `lumen/tests/whisperUnits.test.js`
    - 4.1: starting listening with no in-flight chunks yields `setStatus('listening…', true)`
    - 4.4: stopping listening with `inFlight === 0` and `errored === false` yields `setStatus('listening stopped', false)`
    - _Requirements: 4.1, 4.4_

  - [x]* 10.5 Prompt-injection helpers unchanged smoke test in `lumen/tests/whisperUnits.test.js`
    - 5.3: simulate `Use as prompt`, `Append to prompt`, and `Clear` button handlers operating on `finalTranscript + interimTranscript`; assert the input value and reset behaviors are unchanged from the pre-feature renderer
    - _Requirements: 5.3_

  - [x]* 10.6 Configuration reader unit tests in `lumen/tests/whisperUnits.test.js`
    - 6.1: `readWhisperEndpoint()` returns the default when the key is unset and the configured value when it is set
    - 6.2: `readWhisperModel()` returns the default when the key is unset and the configured value when it is set
    - 6.5: `readGroqKey()` reads `lumen.key.groq` regardless of the value stored under `lumen.backend` or selected via `backendSel.value`
    - _Requirements: 6.1, 6.2, 6.5_

  - [x]* 10.7 Web Speech identifier source-grep test in `lumen/tests/whisperUnits.test.js`
    - 7.3: read `lumen/renderer/renderer.js` from disk and assert the file contains zero matches for each of `SpeechRecognition`, `webkitSpeechRecognition`, `MAX_ERROR_RESTARTS`, `MIN_CLEAN_SESSION_MS`, `consecutiveErrorRestarts`, `lastSessionStartedAt`, `lastError`
    - _Requirements: 7.3_

- [x] 11. Final checkpoint - Full test sweep
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Sub-tasks marked with `*` are optional test tasks and can be skipped for a faster MVP; core implementation tasks (no `*`) must be implemented.
- Each task references the granular sub-requirement clauses it covers in `requirements.md` rather than only the parent user story.
- Property-test sub-tasks (3.2, 6.2, 7.3, 7.4) are placed adjacent to the implementation they validate so failures surface during the same wave the bug would be introduced in.
- The dependency graph below serializes every write to `lumen/renderer/renderer.js`, `lumen/tests/whisperPbt.test.js`, and `lumen/tests/whisperUnits.test.js` because tasks that share a file cannot run in the same wave without conflicts.
- Checkpoint tasks (9, 11) and top-level parent tasks (1, 2, 3, 4, 5, 6, 7, 8, 10) are not included in the dependency graph — only leaf sub-tasks are scheduled.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["3.1"] },
    { "id": 2, "tasks": ["3.2", "4.1"] },
    { "id": 3, "tasks": ["5.1"] },
    { "id": 4, "tasks": ["5.2"] },
    { "id": 5, "tasks": ["6.1"] },
    { "id": 6, "tasks": ["6.2", "7.1"] },
    { "id": 7, "tasks": ["7.2"] },
    { "id": 8, "tasks": ["7.3", "8.1"] },
    { "id": 9, "tasks": ["7.4", "8.2"] },
    { "id": 10, "tasks": ["10.1"] },
    { "id": 11, "tasks": ["10.2"] },
    { "id": 12, "tasks": ["10.3"] },
    { "id": 13, "tasks": ["10.4"] },
    { "id": 14, "tasks": ["10.5"] },
    { "id": 15, "tasks": ["10.6"] },
    { "id": 16, "tasks": ["10.7"] }
  ]
}
```
