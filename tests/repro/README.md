# Manual Reproduction — `file://` Web Speech upload failure

This document captures the manual reproduction steps for **Test A** of task 1
(see `tasks.md`). It complements the automated property-based test in
`tests/bug-condition.test.js` (Test B).

> **Do not run these steps from the agent.** This is a procedure for the user
> to perform out-of-band — it requires Electron, a real microphone, and macOS
> mic permission.

## Prerequisites

- macOS with mic permission already granted to the Electron development app
  (or willing to grant it on first prompt).
- A working network connection (the bug is reproducible online — it is the
  Chromium upload pipeline aborting on the `file://` origin, not a real
  network failure).
- `cd lumen && npm install` already run.

## Steps

1. **Launch the unfixed app with logging enabled:**

   ```sh
   cd lumen
   npm run dev
   ```

   This runs `electron . --enable-logging` so Chromium internals emit to the
   terminal.

2. **Open the Lumen overlay** when the window appears (use `⌘⇧Space` if it
   was hidden by content protection).

3. **Open DevTools** on the overlay window: focus the window then press
   `⌘⌥I` (or right-click → Inspect, if available). Switch to the Console tab.

4. **Click `🎤 Listen`** in the bottom command panel. If macOS prompts for mic
   permission, grant it (the dialog appears once per machine).

5. **Speak a known phrase**, e.g. "the quick brown fox jumps over the lazy
   dog". Do NOT click Stop yet.

6. **Observe the four required signals:**

   1. The terminal where `npm run dev` is running starts emitting lines like
      ```
      [.../chunked_data_pipe_upload_data_stream.cc(...)] OnSizeReceived failed with Error: -2
      ```
      at roughly 600ms cadence.

   2. The DevTools console shows `SpeechRecognitionErrorEvent` with
      `error === 'network'`. To capture this, temporarily add a debug line at
      the top of the existing `r.onerror` handler in
      `renderer/renderer.js` (around line 209):
      ```js
      console.log('[mic-error]', e.error);
      ```
      Re-run `npm run dev`, click 🎤 Listen, then revert the line before
      committing.

   3. The transcript panel `#transcript-text` in the overlay remains empty for
      the entire session — no interim, no final results.

   4. The "🎤 off" badge in the title bar flips to "🎤 on" but never any
      transcript text appears.

7. **Click `🎤 Listen`** again to stop the session. The chunked-upload error
   storm in the terminal should cease.

8. **Capture an excerpt** of the terminal log (8–20 lines is enough to show
   the cadence) and paste it into `tests/repro/observed-counterexample.log`.

## Expected Outcome (unfixed code)

All four signals reproduce on every activation. The upload aborts at
`OnSizeReceived` for the entire session, no transcript is ever emitted, and
the renderer's `onend → start()` handler restarts the session each time the
chunked stream tears down — producing the ~600ms cadence in the log.

## When the fix is in (validation)

After applying tasks 3.1 and 3.2 from `tasks.md`, repeating these steps must
yield:

- DevTools shows `Origin: lumen://app` (not `file://`).
- No `chunked_data_pipe_upload_data_stream.cc` errors during a normal session.
- `#transcript-text` populates with interim results as you speak and a final
  result when you pause.
- If you turn Wi-Fi off and click 🎤 Listen, exactly one user-visible error
  message appears in the transcript panel and the session stops cleanly
  within `MAX_ERROR_RESTARTS` (= 3) attempts.
