# Whisper Mic Transcription — How to Test

The mic now uses **Groq Whisper** (`whisper-large-v3`) instead of Web Speech.
This kills the Google routing dependency and makes transcription actually
work in Electron. This doc walks you through verifying it on your machine.

## What changed

Renderer-only change. Specifically:

- **Web Speech retired**: `setupRecognition` and the `recognition` /
  `MAX_ERROR_RESTARTS` / `consecutiveErrorRestarts` state from the previous
  bugfix are gone.
- **MediaRecorder pipeline added**: mic audio is captured locally, sliced
  into independent ~5-second WebM chunks, and POSTed concurrently to Groq's
  `/v1/audio/transcriptions` endpoint with your existing `lumen.key.groq`.
- **In-order transcript append**: even if response 3 arrives before
  response 1, transcripts append in chunk-emission order so the panel
  reads as you spoke.
- **Single-error funnel**: missing key, mic denied, network failure,
  HTTP non-2xx (with status + first 300 chars of body), or malformed
  JSON each show a single message in the transcript panel and stop.

`main.js` and `preload.js` are untouched.

## Step 1 — Run the automated tests (~3 seconds)

```sh
cd "/Users/maheshkumar/untitled folder/sonu/lumen"
npm test
```

Expected output:

```
✓ tests/whisperPbt.test.js   (6 tests — 4 properties + edge cases)
✓ tests/whisperUnits.test.js (19 tests)

Test Files  2 passed (2)
Tests       25 passed (25)
```

The 4 properties cover:
- **P1**: transcripts append in chunk-emission order regardless of response order
- **P2**: any failure renders exactly one user-visible error and stops cleanly
- **P3**: status line reflects the in-flight POST count
- **P4**: `readChunkSeconds` validator handles every weird input

If anything fails here, stop and tell me — something regressed.

## Step 2 — Make sure your Groq key is set

Open the app once and paste your Groq API key into the backend settings
(or set it via DevTools console: `localStorage.setItem('lumen.key.groq', 'gsk_...')`).
The key starts with `gsk_`. Whisper reuses the same key as the Groq chat
backend — no separate key needed.

## Step 3 — Launch the app

```sh
cd "/Users/maheshkumar/untitled folder/sonu/lumen"
npm run dev
```

The Lumen overlay should appear. Hit `⌘⇧Space` if it's hidden behind
something.

## Step 4 — The actual mic test

1. Click `🎤 Listen` in the bottom command panel.
2. If macOS prompts for mic permission, grant it.
3. Speak a phrase — try something distinctive like "the quick brown fox
   jumps over the lazy dog".
4. Wait ~5 seconds.

What you should see:

- The `🎤 off` badge flips to `🎤 on`.
- Status line shows `listening…`.
- Within ~5 seconds, status flips to `transcribing…`, then back to
  `listening…` once the chunk's response returns.
- Transcribed text appears in the transcript panel.
- Every ~5 seconds another chunk gets transcribed and appended.
- The `chunked_data_pipe_upload_data_stream.cc` errors from before? Gone.

If you see transcripts and a clean terminal, Whisper is working. ✅

## Step 5 — Test the failure paths

Each of these should produce **exactly one** error message in the
transcript panel and stop cleanly (no looping, no spam in the terminal).

**Missing key**:
1. Clear the key: in DevTools console, run `localStorage.removeItem('lumen.key.groq')`.
2. Click `🎤 Listen`. Should immediately show: *"Whisper transcription
   needs a Groq API key. Paste one into the Groq backend settings…"*

**Network failure**:
1. Restore your key.
2. Turn Wi-Fi off.
3. Click `🎤 Listen`, speak. After the first chunk fires, you should see:
   *"Whisper transcription failed: could not reach the transcription
   service. Check network or endpoint."*
4. Turn Wi-Fi back on.

**Bad endpoint**:
1. In DevTools: `localStorage.setItem('lumen.whisper.endpoint', 'https://example.com/404')`.
2. Click `🎤 Listen`, speak. Should show: *"Whisper transcription failed:
   HTTP 404. ..."*
3. Reset: `localStorage.removeItem('lumen.whisper.endpoint')`.

## Step 6 — Configure if you want to

Power-user settings via DevTools console:

```js
// Change chunk duration (1–30 seconds; anything else falls back to 5)
localStorage.setItem('lumen.whisper.chunkSeconds', '3');

// Point at a self-hosted OpenAI-compatible Whisper endpoint
localStorage.setItem('lumen.whisper.endpoint', 'http://localhost:8080/v1/audio/transcriptions');

// Use a different Whisper model (any model your endpoint supports)
localStorage.setItem('lumen.whisper.model', 'whisper-medium-en');

// Reset to defaults
localStorage.removeItem('lumen.whisper.chunkSeconds');
localStorage.removeItem('lumen.whisper.endpoint');
localStorage.removeItem('lumen.whisper.model');
```

Changes take effect on the next `🎤 Listen` click.

## Step 7 — Regression sweep

Confirm nothing else broke:

- `⌘⇧Space` toggles overlay
- `⌘⇧L` focuses the input
- `⌘⇧T` toggles click-through
- `📷 Share screen` works
- Chat with the Echo backend echoes back
- Chat with Groq streams a response
- A screenshot (`⌘⇧4`) does NOT capture the overlay (content protection)

## What's left

These were the other items you mentioned — each gets its own spec:

- **See-through mode toggle** (button + hotkey to make the overlay
  semi-transparent so you can read what's behind it). Spec next.
- System-audio transcription (the other side of a meeting)
- Custom screen-share picker with thumbnails
- Persistent chat history across launches

Whisper migration is done. When you're ready, we'll start the see-through
toggle spec.

## If something goes wrong

- **"Mic transcription unavailable" on click**: your `lumen.key.groq` is
  empty or invalid. Paste a fresh `gsk_...` key.
- **HTTP 401 / 403 errors**: key is invalid or expired. Regenerate at
  groq.com.
- **HTTP 413 (payload too large)**: chunk got too big. Lower
  `lumen.whisper.chunkSeconds` to 3 or 2.
- **Transcripts come back with weird text**: model could be hallucinating
  on a too-short chunk. Try `lumen.whisper.chunkSeconds = '8'`.
- **Tests fail**: paste the failure output. Do not proceed to live
  testing until tests are green.

## Files to reference

- `.kiro/specs/whisper-mic-transcription/requirements.md` — the requirements
- `.kiro/specs/whisper-mic-transcription/design.md` — the analysis and architecture
- `.kiro/specs/whisper-mic-transcription/tasks.md` — the implementation plan
- `tests/whisperHarness.js` — the test harness (mirrors the Whisper_Client design)
- `tests/whisperPbt.test.js` — the property tests
- `tests/whisperUnits.test.js` — the example-based unit tests
