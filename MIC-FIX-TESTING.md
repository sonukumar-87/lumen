# Mic Transcription Fix — How to Test

The mic bug (`OnSizeReceived failed with Error: -2` storm, no transcripts)
has been fixed. This doc walks you through verifying it on your machine.

## What was changed

Two files. Nothing else.

- **`main.js`** — the renderer used to load over `file://`, which Chromium
  ~128 (Electron 32) rejects for the Web Speech upload pipeline. Now it
  loads over a registered `lumen://` privileged secure scheme. That's what
  actually unblocks the upload.
- **`renderer/renderer.js`** — the auto-restart loop used to retry blindly
  on every `onend`, which turned a single failure into the ~600ms storm.
  Now it's error-class-aware: bounded retries with exponential backoff
  for soft errors, hard stop with a visible message in the transcript
  panel for `network` errors, and the legitimate ~60s session rotation
  is preserved.

## Step 1 — Run the automated tests (sanity check, ~5 seconds)

```sh
cd lumen
npm install   # only needed once if you haven't already
npm test
```

Expected output:

```
✓ tests/preservation.test.js (5)
✓ tests/bug-condition.test.js (1)

Test Files  2 passed (2)
Tests       6 passed (6)
```

If anything fails here, stop and tell me — something regressed.

## Step 2 — Launch the app

```sh
cd lumen
npm run dev
```

The Lumen overlay should appear in the top-right of your screen. If it's
hidden behind something, hit `⌘⇧Space` to bring it forward.

## Step 3 — Verify the secure origin loaded

Open DevTools on the overlay window:
- Right-click somewhere on the overlay → Inspect, **or**
- Focus the overlay and press `⌘⌥I`

Switch to the **Console** tab, type:

```js
location.origin
```

Expected: `"lumen://app"` (not `"file://"`). That's the proof that the
protocol scheme change took effect.

## Step 4 — The actual mic test

1. Click `🎤 Listen` in the bottom command panel.
2. If macOS prompts for mic permission, grant it.
3. Speak a phrase, e.g. "the quick brown fox jumps over the lazy dog".

What you should see:
- The `🎤 off` badge in the title bar flips to `🎤 on`.
- Interim text appears in the transcript panel as you speak (greyed-out).
- A final transcript locks in when you pause.
- The terminal where `npm run dev` is running stays quiet — **no**
  `chunked_data_pipe_upload_data_stream.cc OnSizeReceived failed with
  Error: -2` lines.

If you see transcripts and a clean terminal, the bug is fixed. ✅

## Step 5 — Test the graceful failure path

This proves Requirement 2.5 (genuine network failure surfaces a clear
message, doesn't silently spin).

1. Stop the current session (click `🎤 Listen` again).
2. **Turn Wi-Fi off** (or block network however you like).
3. Click `🎤 Listen` again.

What you should see:
- A single user-visible error message in the transcript panel:
  `Mic transcription unavailable: speech service is unreachable. Check
  network or try again.`
- The badge flips back to `🎤 off`.
- The terminal does NOT keep spamming chunked-upload errors. At most a
  few attempts (capped at `MAX_ERROR_RESTARTS = 3`), then quiet.

Turn Wi-Fi back on for the next steps.

## Step 6 — Regression sweep (everything else still works)

Run through each of these to confirm nothing else broke from the protocol
scheme change:

- **Hotkeys**: `⌘⇧Space` toggles overlay visibility, `⌘⇧L` focuses the
  input, `⌘⇧T` toggles click-through.
- **Window nudge**: `⌘⇧↑` / `⌘⇧↓` / `⌘⇧←` / `⌘⇧→` move the window.
- **Screen share**: click `📷 Share screen`. Native picker should appear
  (or auto-pick primary screen on systems without it). Toggle it off.
- **Chat with Echo backend**: select `echo` in the backend dropdown,
  type something, hit `⌘⏎`. Should echo back.
- **Chat with Groq** (if you have a key): select `groq`, paste your key,
  hit save, send a prompt. Should stream a response.
- **Content protection**: take a screenshot (`⌘⇧4`) and confirm the
  overlay does NOT appear in the captured image.
- **Manual stop**: click `🎤 Listen` to start, then click again to stop.
  Should cleanly end.
- **macOS mic permission denial**: if you want to be thorough, deny mic
  in System Settings → Privacy → Microphone → Lumen, restart the app,
  click `🎤 Listen`. Should deep-link you back to System Settings.

## What's left (separate features, not part of this fix)

These were the other items you mentioned. Each deserves its own spec:

- System-audio transcription (the other side of a meeting)
- Custom screen-share picker with thumbnails
- Persistent chat history across launches

When you're ready to tackle one of those, just say which.

## If something goes wrong

- **DevTools console shows errors related to `lumen://`**: paste them and
  I'll diagnose. Likely cause is the `protocol.handle` setup not finding
  a file (path traversal guard or wrong host).
- **Transcripts still don't appear, but no errors**: confirm `location.origin`
  is `lumen://app` from Step 3. If it is, the upload is reaching Google
  but transcription isn't returning — could be the stripped-API-key
  hypothesis from `design.md` (root cause #3). Tell me and we'll go to
  Whisper/Groq.
- **Tests fail in Step 1**: paste the failure output. Don't proceed to
  Step 2 until tests are green.

## Files to reference

- `.kiro/specs/mic-transcription-broken/bugfix.md` — the requirements
- `.kiro/specs/mic-transcription-broken/design.md` — the analysis and fix design
- `.kiro/specs/mic-transcription-broken/tasks.md` — the implementation plan
- `tests/repro/README.md` — earlier manual repro doc (useful background)
- `tests/repro/observed-counterexample.log` — the bug → fix transition trace
