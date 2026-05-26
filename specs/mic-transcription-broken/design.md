# Mic Transcription Broken — Bugfix Design

## Overview

Mic transcription in Lumen activates the Web Speech API (`window.webkitSpeechRecognition` in `renderer.js`), but the Chromium-internal chunked HTTP upload that streams audio to Google's speech endpoint fails immediately with `net::FAILED` (`OnSizeReceived failed with Error: -2` from `chunked_data_pipe_upload_data_stream.cc`). The `SpeechRecognition` session aborts before any transcript is produced, and the renderer's `onend` handler in `renderer.js` immediately re-calls `recognition.start()`, producing the observed ~600ms repeating cadence.

The fix is two-pronged and stays on the Web Speech path:

1. **Restore upload viability by loading the renderer from a secure custom protocol origin (`lumen://app/…`) instead of `file://`.** Chromium's Web Speech client refuses to perform the chunked upload to Google's speech endpoint from `file://` origins in modern Chromium (Electron 32 → Chromium 128); the upload pipeline aborts at the chunked-stream layer, which is exactly the symptom we see. Serving the renderer from a registered, privileged secure scheme via `protocol.handle` gives Web Speech a real, secure origin, restoring the upload path without changing renderer source layout.

2. **Replace the unconditional, zero-backoff `onend` auto-restart with an error-aware restart policy.** Today `r.onend` calls `r.start()` whenever `listening` is true, regardless of whether the session ended cleanly or because of a `network` error. The fix tracks the last error and the session start time, only auto-restarts on clean rotations (the ~60s cap), applies bounded retries with backoff for transient errors, and on `network` failures stops the loop and surfaces a user-visible error in the transcript panel.

Out of scope: replacing Web Speech with a local engine (Whisper/Groq). Keep the fix on the existing Web Speech path.

## Glossary

- **Bug_Condition (C)**: A mic activation that starts a `SpeechRecognition` session whose chunked HTTP upload to Google's speech endpoint fails with `net::FAILED` (surfaced to JS as a `SpeechRecognitionErrorEvent` with `error: 'network'`).
- **Property (P)**: The fixed code SHALL either (a) produce interim and final transcripts as the user speaks, or (b) when the upload genuinely cannot be established, surface a single user-visible error in the transcript panel and stop the auto-restart loop.
- **Preservation**: All non-mic behavior, the macOS mic-permission deep link, transcript panel rendering, the manual-stop flow, and the legitimate ~60s session rotation must continue to work exactly as before.
- **`setupRecognition`**: Function in `renderer/renderer.js` (lines 191–225) that constructs the `SpeechRecognition` instance and wires `onresult`, `onerror`, `onend`.
- **`toggleListen`**: Function in `renderer/renderer.js` (lines 257–283) that starts/stops a recognition session in response to the `🎤 Listen` button.
- **`listening`**: Module-scoped boolean in `renderer/renderer.js` (line 34) that gates the auto-restart in `onend`.
- **`finalTranscript` / `interimTranscript`**: Module-scoped strings (lines 35–36) accumulated in `onresult` and rendered by `renderTranscript()`.
- **Renderer origin**: The URL scheme/host the renderer document is loaded from. Currently `file://` via `win.loadFile('renderer/index.html')` in `main.js` line 76. After the fix, `lumen://app/index.html`.
- **Web Speech network error**: `SpeechRecognitionErrorEvent` with `error === 'network'`. This is the JS-visible manifestation of the chunked upload failure described in the bug condition.

## Bug Details

### Bug Condition

The bug manifests when the user clicks `🎤 Listen` and `toggleListen()` calls `recognition.start()` (renderer.js:271). Chromium begins the chunked HTTP upload to Google's speech endpoint and the upload fails at the `ChunkedDataPipeUploadDataStream` layer with `net::FAILED` (`Error: -2`) before any audio frames are transcribed. Chromium reports this to JS as a `SpeechRecognitionErrorEvent` with `error: 'network'`, fires `onend`, and the current `onend` handler (renderer.js:219–222) blindly calls `r.start()` again — re-triggering the same failure roughly every 600ms.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type MicActivation
    input.recognitionStart   : boolean   // toggleListen called recognition.start()
    input.uploadOutcome      : enum { OK, NET_FAILED, OTHER }
    input.errorEvent         : SpeechRecognitionErrorEvent | null
    input.permissionGranted  : boolean
  OUTPUT: boolean

  RETURN input.recognitionStart
         AND input.permissionGranted
         AND input.uploadOutcome == NET_FAILED
         AND (input.errorEvent != null AND input.errorEvent.error == 'network')
         AND no_transcript_emitted_before_failure(input)
END FUNCTION
```

### Examples

- **Cold start, online, mic permission granted (current observed bug)**: User clicks `🎤 Listen` → `recognition.start()` → Chromium logs `OnSizeReceived failed with Error: -2` from `chunked_data_pipe_upload_data_stream.cc` → `onerror` fires with `e.error === 'network'` → `onend` fires → `r.start()` is called again → cycle repeats every ~600ms. Expected: interim/final transcripts appear in `#transcript-text`. Actual: empty panel, console flooded with `net::FAILED`.
- **Renderer loaded over `file://` (`main.js:76 win.loadFile(...)`)**: The document origin is `file://` with no host. Chromium's Web Speech client cannot establish the upload to Google's speech endpoint from this origin in Electron 32 (Chromium 128). Expected: working upload. Actual: chunked stream aborts with `Error: -2`.
- **Genuinely offline / endpoint unreachable**: Same JS-level symptom (`error: 'network'`) but here the failure is environmental rather than origin-related. Expected: a single user-facing error in the transcript panel and no auto-restart loop. Actual: same tight 600ms restart loop, no user message.
- **Edge case — error event without `listening = false`**: Today's `onerror` handler (renderer.js:208–219) only sets `listening = false` for `'not-allowed'` / `'service-not-allowed'`. For `'network'` it just calls `setStatus(...)` and leaves `listening = true`, so `onend` proceeds to auto-restart. Expected: stop after a network error and surface a clear message. Actual: silent restart loop.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- macOS mic permission denial (`error === 'not-allowed'` or `'service-not-allowed'`) MUST still call `L.openMicPerms()` to deep-link System Settings (renderer.js:210–214). [Requirement 3.1]
- The transcript panel rendering pipeline — `onresult` → `finalTranscript` / `interimTranscript` → `renderTranscript()` (renderer.js:197–207, 226–240) — MUST be untouched and continue to render live interim and final transcripts. [Requirement 3.2]
- All non-mic features (chat history, screen share via `getDisplayMedia`, Groq/Gemini/Ollama backends, hotkeys, click-through, window controls, content protection) MUST be unaffected. [Requirement 3.3]
- Manual stop via the `🎤 Listen` button (renderer.js:265–269) MUST continue to call `recognition.stop()`, set `listening = false`, and prevent any further auto-restart. [Requirement 3.4]
- The legitimate ~60s session rotation — when a session ends cleanly with no error — MUST continue to auto-restart so the user does not have to re-click the button every minute. [Requirement 3.5]

**Scope:**
All inputs that do NOT match the bug condition (no `network` error on the chunked upload) should be completely unaffected by this fix. This includes:
- Mic permission denial flows.
- Normal `~60s` clean session rotation.
- Manual stop.
- Transcript rendering and prompt-injection actions (`Use as prompt`, `Append to prompt`, `Clear`).
- Screen share, chat backends, hotkeys, content protection, IPC, preload bridge.

## Hypothesized Root Cause

Based on the renderer source, the Electron version (`^32.0.0`, Chromium ~128), and the specific Chromium internal that emits the failure (`chunked_data_pipe_upload_data_stream.cc`), the most likely causes — in order of confidence — are:

1. **`file://` origin rejected by Chromium's Web Speech upload pipeline (primary).**
   - `main.js:76` loads the renderer with `win.loadFile('renderer/index.html')`, giving the document a `file://` origin.
   - Chromium's Web Speech implementation streams microphone audio to Google's speech endpoint using a chunked POST. In modern Chromium, this upload is rejected for opaque/`file://` origins; the rejection surfaces inside `ChunkedDataPipeUploadDataStream` as `net::FAILED` because the upload stream's first read (`OnSizeReceived`) cannot resolve a valid request and aborts with `Error: -2`.
   - This matches the observed symptom: failure happens at session start before any audio frame, and is reproducible on every activation regardless of network conditions.

2. **Auto-restart loop amplifies a single failure into a 600ms storm (secondary, definitely present).**
   - `renderer.js:219–222` unconditionally calls `r.start()` from `onend` whenever `listening` is true.
   - `renderer.js:208–219` does not set `listening = false` for `error === 'network'` (it only does so for `'not-allowed'`/`'service-not-allowed'`).
   - Net effect: any persistent failure cause becomes a tight `onerror → onend → r.start() → onerror …` loop. Even if (1) is fixed, this remains a latent bug.

3. **Electron's stripped Google API key for Web Speech (possible contributor).**
   - Chromium's Web Speech client uses a Google-internal API key that is removed from non-official Chromium builds (including Electron). When the key is absent, the speech service request can be rejected at the network/edge layer, surfacing as the same chunked upload failure.
   - Note: many Electron apps do successfully use Web Speech in practice when served from a non-`file://` origin, suggesting the origin is the dominant gate; we treat this as a fallback hypothesis to keep in mind during exploratory testing.

4. **Network/proxy/regional block (least likely, environment-dependent).**
   - A corporate proxy, VPN, or regional restriction on Google's speech endpoint would also surface as `error: 'network'`. This cannot be ruled out at design time and must be handled gracefully regardless: it is precisely the case Requirement 2.5 calls out (surface a user-visible error, do not loop).

If exploratory tests on the unfixed `file://` build confirm hypothesis (1), serving the renderer from a registered secure custom-protocol origin will resolve C(X) for the typical user. Hypothesis (2) is fixed independently in renderer.js and is the safety net for hypotheses (3) and (4).

## Correctness Properties

Property 1: Bug Condition - Successful Upload or Graceful Failure on Mic Activation

_For any_ mic activation where the bug condition holds (a `SpeechRecognition` session is started and the chunked upload would otherwise fail with `net::FAILED` / `error: 'network'`), the fixed renderer SHALL satisfy at least one of the following:
(a) The upload succeeds and `onresult` emits at least one interim or final transcript when audible speech is provided, OR
(b) The renderer surfaces a clear, user-visible error message in the transcript panel and stops the recognition session within a bounded number of restart attempts, leaving `listening === false` and `recognition` not actively running.

In no case SHALL the fixed code re-enter the unbounded ~600ms restart loop on a persistent `network` error.

**Validates: Requirements 2.1, 2.2, 2.3, 2.5**

Property 2: Preservation - Non-Bug Behavior Unchanged

_For any_ input where the bug condition does NOT hold (mic-permission denial, clean `~60s` session end with no error, manual stop, normal transcript rendering, and all non-mic flows), the fixed code SHALL produce the same observable behavior as the original code, preserving:
- The `not-allowed` / `service-not-allowed` → `L.openMicPerms()` deep link.
- The interim/final transcript rendering pipeline.
- The auto-restart on clean session end (Web Speech's ~60s cap).
- The manual-stop behavior of the `🎤 Listen` button.
- All non-mic features (chat, screen share, hotkeys, IPC, content protection).

**Validates: Requirements 2.4, 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct, the fix touches two files: `main.js` (renderer load path / custom protocol) and `renderer/renderer.js` (error-aware restart policy and user-facing error surfacing). No HTML/CSS structural change is needed; the existing transcript panel is reused for the user-facing error message.

---

**File**: `lumen/main.js`

**Functions**: top-level imports, `app.whenReady()` callback, `createWindow()`

**Specific Changes**:

1. **Register `lumen://` as a privileged secure standard scheme** (must run before `app.whenReady`):
   - Add `protocol` to the destructured `electron` import at the top of `main.js`.
   - Call `protocol.registerSchemesAsPrivileged([{ scheme: 'lumen', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])` at module top level (before `app.whenReady`).
   - This gives the renderer a real, secure, standard origin that Chromium's Web Speech upload pipeline accepts.

2. **Implement `protocol.handle('lumen', …)` inside `app.whenReady().then(...)`** (before `createWindow()`):
   - Map `lumen://app/<path>` to the absolute filesystem path under `__dirname`.
   - Reject path traversal (`..` segments) and any host other than `app`.
   - Default `lumen://app/` to `lumen://app/index.html`.
   - Use `net.fetch(url.pathToFileURL(absolutePath).toString())` (importing `net` from `electron` and `url` from Node) so MIME types and ranges are handled correctly.

3. **Replace `win.loadFile('renderer/index.html')` with `win.loadURL('lumen://app/index.html')`** in `createWindow()` (currently `main.js:76`).

4. **Leave all other `BrowserWindow` settings untouched** — `contextIsolation`, `nodeIntegration: false`, `sandbox: false`, the preload path, content protection, the `setDisplayMediaRequestHandler`, IPC handlers, and the global hotkeys are all unaffected. The preload bridge continues to expose `window.lumen`.

---

**File**: `lumen/renderer/renderer.js`

**Functions**: `setupRecognition` (lines 191–225), `toggleListen` (lines 257–283); add small helpers and DOM message rendering for user-facing errors.

**Specific Changes**:

1. **Add restart-policy state variables** alongside the existing module state (after line 36):
   - `let consecutiveErrorRestarts = 0;` — count of restart attempts triggered by an error since the last clean result/end.
   - `let lastSessionStartedAt = 0;` — timestamp set on each successful `recognition.start()`.
   - `let lastError = null;` — most recent `SpeechRecognitionErrorEvent.error` string, cleared on successful `onresult` and on manual start.
   - Constants: `const MAX_ERROR_RESTARTS = 3;` and `const MIN_CLEAN_SESSION_MS = 1000;` — anything ending in under 1s without a result is treated as a failed session, not a clean rotation.

2. **Update `onresult` to clear the error counters** (renderer.js:197–208):
   - On any received result, set `consecutiveErrorRestarts = 0;` and `lastError = null;`. This ensures a single transient hiccup followed by recovery does not later trip the cap.

3. **Rewrite `onerror`** (renderer.js:208–219) to be error-class aware:
   - Set `lastError = e.error;`.
   - For `'not-allowed'` / `'service-not-allowed'`: keep existing behavior (status, `L.openMicPerms()`, `listening = false`, `updateListenUI()`).
   - For `'no-speech'`: keep ignoring (clean rotation, not a failure).
   - For `'network'`: stop the loop authoritatively — set `listening = false`, call `updateListenUI()`, and call a new `showTranscriptError(...)` helper that renders a user-visible message in `#transcript-text` (Requirement 2.5). Suggested copy: "Mic transcription unavailable: speech service is unreachable. Check network or try again."
   - For `'aborted'` / `'audio-capture'` / unknown: increment `consecutiveErrorRestarts`; if it exceeds `MAX_ERROR_RESTARTS`, stop the loop (`listening = false`, `updateListenUI()`, `showTranscriptError(...)`), otherwise allow `onend` to schedule a restart with backoff.

4. **Rewrite `onend`** (renderer.js:219–222) to gate the auto-restart:
   - If `listening` is false, do nothing (manual stop / authoritative error stop).
   - If `lastError` is non-null AND `consecutiveErrorRestarts >= MAX_ERROR_RESTARTS`, do nothing (cap reached, error already surfaced).
   - If the session ran for less than `MIN_CLEAN_SESSION_MS` AND `lastError` was a hard error (e.g., `'network'`, `'audio-capture'`), do nothing (treat as failed session). Otherwise:
   - For a clean rotation (no `lastError`, runtime ≥ `MIN_CLEAN_SESSION_MS`), restart immediately — this preserves the existing ~60s rotation behavior (Requirement 3.5).
   - For a soft error within the retry budget, restart after a short backoff (`setTimeout(..., 500 * 2 ** consecutiveErrorRestarts)`).

5. **Update `toggleListen`'s start branch** (renderer.js:269–278) to reset the new counters: `consecutiveErrorRestarts = 0; lastError = null; lastSessionStartedAt = Date.now();` (set start time on each manual start).

6. **Add `showTranscriptError(message)` helper** (alongside `renderTranscript`):
   - Render a `<div class="err">…</div>` (the `.err` style already exists in `index.html` for chat error messages) into `#transcript-text` so the user sees a clear, persistent message rather than just the `#status` line ticking. This keeps the change purely additive with respect to existing CSS and DOM.
   - Set `setStatus('mic stopped due to error', false)` for parity with existing UX language.

7. **Do not alter** `renderTranscript`, `updateListenUI`, the prompt-injection buttons, or any non-mic code path. The screen capture, chat backends, hotkey wiring, and IPC remain untouched.

## Testing Strategy

### Validation Approach

The strategy follows two phases. First, run exploratory tests on the unfixed code to surface concrete counterexamples that confirm or refute the root cause hypotheses (especially: is the `file://` origin the dominant cause?). Second, after applying the fix, verify that (a) for inputs satisfying C(X) the renderer either receives transcripts or surfaces a single visible error and stops; and (b) for inputs not satisfying C(X), behavior is identical to the original.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root-cause hypothesis that the `file://` origin and the unconditional restart loop together produce the observed `net::FAILED` storm.

**Test Plan**: Launch the unfixed app with `npm run dev` (`electron . --enable-logging`), open DevTools on the overlay, click `🎤 Listen`, and capture the console. Observe (i) the `chunked_data_pipe_upload_data_stream.cc OnSizeReceived failed with Error: -2` log lines, (ii) the cadence of repeated failures, (iii) the JS-visible `SpeechRecognitionErrorEvent.error` value, and (iv) whether `#transcript-text` ever populates. Repeat with a one-off local patch that swaps `loadFile` for a temporary `loadURL('lumen://app/index.html')` (custom-protocol scaffold only, no other changes) to test hypothesis (1) in isolation.

**Test Cases**:
1. **Unfixed `file://` activation**: Click `🎤 Listen` and speak. Expected counterexample: `e.error === 'network'`, no transcript, `chunked_data_pipe_upload_data_stream.cc` errors fire roughly every 600ms (will fail on unfixed code).
2. **Unfixed `file://` no-speech**: Click `🎤 Listen` and stay silent. Expected: same `network` error storm regardless of audio (will fail on unfixed code) — confirms the failure is at the upload layer, not audio-detection.
3. **Custom-protocol scaffold only (no other change)**: Renderer loaded from `lumen://app/index.html`. Expected: upload succeeds, `onresult` fires with interim transcripts. If still fails with `network`, hypothesis (1) is refuted and we re-hypothesize (likely hypothesis 3, missing API key).
4. **Edge: airplane mode on `lumen://` build**: Disable network, click `🎤 Listen`. Expected: a single `network` error, then unchanged-state restart loop on the unfixed restart logic (will fail on unfixed code by entering the tight loop).

**Expected Counterexamples**:
- `SpeechRecognitionErrorEvent.error === 'network'` on every session start.
- Console shows the `chunked_data_pipe_upload_data_stream.cc` line repeating at ~600ms.
- `#transcript-text` remains empty across the entire session.
- Possible causes: `file://` origin rejected by Chromium upload pipeline (primary), zero-backoff `onend` restart amplifies the failure (secondary, always present), missing Google API key in Electron's Chromium (fallback), proxy/regional block (environment).

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed renderer produces the expected behavior — either successful transcripts, or a clear user-facing error and a stopped session within a bounded number of restart attempts.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := activateMicAndObserve(input)  // start session under fixed code
  ASSERT (result.gotInterimOrFinalTranscript == true)
         OR (result.transcriptPanelShowsError == true
             AND result.listening == false
             AND result.errorRestartAttempts <= MAX_ERROR_RESTARTS
             AND result.tightLoopDetected == false)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed code produces the same observable result as the original — same permission deep-link, same ~60s rotation, same manual-stop behavior, same transcript rendering, same non-mic flows.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT observable(originalRenderer(input)) == observable(fixedRenderer(input))
END FOR

WHERE observable(...) captures:
  - mic permission deep-link invocation (L.openMicPerms calls)
  - sequence of (finalTranscript, interimTranscript) snapshots after each onresult
  - listening state transitions (start/stop/end)
  - auto-restart calls on clean session end
  - non-mic: backend selection, screen share, hotkeys, IPC messages
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- The non-bug input domain (mock `SpeechRecognitionEvent` sequences, permission states, click-through values, screen-share toggles, backend changes) is large and combinatorial.
- It generates many test cases automatically across that domain.
- It catches edge cases manual unit tests miss — particularly around the restart-policy state machine (interleavings of `onresult` / `onerror` / `onend` that are hard to enumerate by hand).
- It provides strong guarantees that observable behavior is unchanged for every non-buggy input class.

**Test Plan**: Observe behavior on UNFIXED code first for the non-bug paths (permission denial path, manual stop, transcript rendering with synthetic events, non-mic features), record the observable signatures, then write property-based tests that drive the fixed code's `setupRecognition` / `toggleListen` with synthetic event streams and assert the same signatures.

**Test Cases**:
1. **Mic permission denial preservation**: Drive `r.onerror({error: 'not-allowed'})` and `{error: 'service-not-allowed'}`. Observe on unfixed: status set, `L.openMicPerms()` called on darwin, `listening` cleared. Assert identical on fixed.
2. **Clean ~60s rotation preservation**: Drive a session that fires several `onresult` events, then `onend` with no preceding error and runtime ≥ `MIN_CLEAN_SESSION_MS`. Observe on unfixed: `r.start()` re-invoked. Assert fixed re-invokes `r.start()` exactly once with no error message rendered.
3. **Manual-stop preservation**: Call `toggleListen()` when `listening` is true. Observe on unfixed: `recognition.stop()` called, `listening = false`, no further auto-restart. Assert identical on fixed.
4. **Transcript rendering preservation**: Drive a sequence of synthetic `onresult` events with mixed `isFinal` flags. Assert that, after every event, `finalTranscript`, `interimTranscript`, and the rendered DOM in `#transcript-text` match between original and fixed renderers.
5. **`no-speech` preservation**: Drive `r.onerror({error: 'no-speech'})`. Original ignores it; fixed must also ignore it (no error message rendered, `listening` unchanged, no restart counter increment that would later break the cap).
6. **Non-mic preservation**: Exercise screen share toggle, backend select, model input, hotkey events, IPC `focus-input` / `click-through`. Assert identical observable behavior.

### Unit Tests

- `setupRecognition` constructs a `SpeechRecognition` with `continuous: true`, `interimResults: true`, and `lang === navigator.language || 'en-US'`.
- `onerror` with `error: 'network'` sets `listening = false`, renders an error message in `#transcript-text`, and prevents the next `onend` from calling `r.start()`.
- `onerror` with `error: 'not-allowed'` invokes `L.openMicPerms()` on `darwin` and sets `listening = false` (regression guard for Requirement 3.1).
- `onresult` clears `lastError` and resets `consecutiveErrorRestarts` to 0.
- `onend` after a clean session (no `lastError`, runtime ≥ `MIN_CLEAN_SESSION_MS`) calls `r.start()` exactly once.
- `onend` after a hard error past the retry cap does not call `r.start()`.
- `toggleListen`'s start branch resets `lastError`, `consecutiveErrorRestarts`, and stamps `lastSessionStartedAt`.
- `main.js` registers `lumen` as `{ standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }` before `app.ready` and serves `lumen://app/index.html` to a real file under `renderer/`.

### Property-Based Tests

- For arbitrary sequences of `onresult` / `onerror` / `onend` events drawn from the Web Speech event grammar, the fixed `recognition.start()` invocation count is bounded by `MAX_ERROR_RESTARTS + (number of clean rotations) + 1` — i.e., no input sequence drives an unbounded restart loop. This validates Property 1.
- For arbitrary event sequences that contain no `'network'` / `'audio-capture'` / `'aborted'` errors and at least one valid `onresult`, the fixed code's `(finalTranscript, interimTranscript)` trace equals the original code's trace at every step. This validates Property 2 for the rendering pipeline.
- For arbitrary `clickThrough`, `backend`, `apiKey`, and `model` inputs, non-mic observable state (DOM, `localStorage`, `setStatus` arguments) is identical between original and fixed.

### Integration Tests

- End-to-end mic flow under `lumen://`: launch the app, click `🎤 Listen`, speak a known phrase, assert at least one final transcript appears in `#transcript-text` and the visible `🎤` badge transitions to `on`.
- End-to-end ~60s rotation: run a continuous session past 60s; assert the transcript continues to update across the rotation boundary with no error message rendered.
- End-to-end offline failure: disable network, click `🎤 Listen`, assert exactly one user-visible error message appears in the transcript panel, `listening` returns to false, and the `chunked_data_pipe_upload_data_stream.cc` log lines do not exceed `MAX_ERROR_RESTARTS` occurrences.
- End-to-end manual stop while erroring: induce a `network` error, but click `🎤 Listen` to stop before the cap is reached; assert no further restart attempts occur and `listening` is false.
- Non-mic regression sweep: open the app, exercise screen share, run an Ask round-trip on each backend (echo, groq, gemini, ollama if configured), and verify hotkeys (`⌘⇧Space`, `⌘⇧L`, `⌘⇧T`) still work — confirms the protocol-scheme switch did not break preload, IPC, or content protection.
