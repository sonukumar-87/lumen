# Lumen — AI assistant handoff

Paste this entire file (or upload it as an attachment) at the start of any
new conversation with Claude / Cursor / ChatGPT / Copilot when you want
help modifying Lumen. The AI will know the project without you having to
re-explain.

---

## What Lumen is

Lumen is a privacy-first AI overlay assistant for macOS, built with Electron.
It floats above all windows, is hidden from screen capture
(`setContentProtection(true)`), and provides:

- **Chat** with 8 LLM backends: Groq, Google Gemini, OpenAI, Claude (Anthropic),
  DeepSeek, Grok (xAI), Mistral AI, Ollama (local), Echo (no-op)
- **Model version picker** — per-backend dropdown of known model versions + custom ID input
- **Mic transcription** via Groq Whisper (`whisper-large-v3`), with RMS silence
  detection to suppress hallucinations on silent audio
- **Screenshot to AI** — one-shot capture, crop overlay, attach to next prompt
- **Continuous screen share** for live frame attachment per Ask
- **Image attachment** from disk via the 📎 Attach pill
- **Quick actions**: Summarize, Explain, Translate, Improve
- **Custom negative prompting** (configurable in Settings)
- **See-through opacity** (slider 20–100% + `⌘⇧O` cycle)
- **Chat font zoom** (`⌘+` / `⌘-` / `⌘0`)
- **Sidebar navigation** with Chat, Ask from Screen, Listen, Quick Actions,
  Notes, History, Settings panes

Repo: https://github.com/sonukumar-87/lumen

---

## Tech stack — strict constraints

- **Electron 32** (don't downgrade or upgrade without user approval)
- **Plain HTML / CSS / JS** — NO React, NO Vue, NO Svelte, NO Tailwind, NO
  build pipeline. Just edit `renderer/index.html` and `renderer/renderer.js`
  and reload.
- **vitest + fast-check** for tests (already in `devDependencies`)
- **electron-builder** for packaging
- No new `npm` dependencies without explicit user approval.

---

## File layout

```
lumen/
├── main.js                 # Electron main: window, hotkeys, IPC handlers,
│                             desktopCapturer, lumen:// protocol handler,
│                             opacity tween.
├── preload.js              # contextBridge IPC bridge → window.lumen.*
├── renderer/
│   ├── index.html          # ALL UI MARKUP + CSS in one file (intentional).
│   ├── renderer.js         # ALL renderer logic in one file (intentional).
│   └── avatar.png          # bottom-left avatar image
├── tests/
│   ├── whisperHarness.js   # pure JS reimplementation of the Whisper pipeline
│   ├── whisperPbt.test.js  # property tests via fast-check
│   ├── whisperUnits.test.js# unit tests
│   └── opacityHarness.js   # opacity controller harness
├── build/
│   ├── icon.icns / raw-icon.jpg
│   ├── entitlements.mac.plist
│   └── build-icon-from-raw.sh
├── package.json            # version, scripts, electron-builder config
├── README.md
└── AI-HANDOFF.md           # this file
```

---

## LLM backends — current implementation

### Backend identifiers (value of `backendSel.value`)

`echo` | `groq` | `gemini` | `openai` | `claude` | `deepseek` | `grok` | `mistral` | `ollama`

### Key constants in `renderer.js`

```js
TEXT_DEFAULTS   // default text model per backend
VISION_DEFAULTS // model used when an image is attached
VISION_HINTS    // hint text shown under the model field
MODEL_CATALOGUE // { [backend]: [{ id, label }, ...] } — drives the picker dropdown
```

### Streaming functions

| Backend | Function | API endpoint |
|---|---|---|
| Groq | `streamGroq()` | `https://api.groq.com/openai/v1/chat/completions` |
| Gemini | `streamGemini()` | `https://generativelanguage.googleapis.com/v1beta/models/…` |
| OpenAI | `streamOpenAI()` | `https://api.openai.com/v1/chat/completions` |
| Claude | `streamClaude()` | `https://api.anthropic.com/v1/messages` |
| DeepSeek | `streamDeepSeek()` | `https://api.deepseek.com/chat/completions` |
| Grok | `streamGrok()` | `https://api.x.ai/v1/chat/completions` |
| Mistral | `streamMistral()` | `https://api.mistral.ai/v1/chat/completions` |
| Ollama | `streamOllama()` | `http://localhost:11434/api/chat` |

Groq, OpenAI, Grok, Mistral, and DeepSeek all use the same OpenAI-compatible
SSE format and share `streamSSE()`. Claude has its own SSE parser
(`content_block_delta` events). Gemini has its own SSE parser too.

### Adding a new backend

1. Add the backend value to the `<select id="backend">` in `index.html`.
2. Add entries to `TEXT_DEFAULTS`, `VISION_DEFAULTS`, `VISION_HINTS`,
   `MODEL_CATALOGUE` in `renderer.js`.
3. Add a `syncRows()` label/placeholder branch in `renderer.js`.
4. Add a `check()` branch that pings the provider's `/models` endpoint.
5. Write a `streamXxx(target, image)` function.
6. Route it in `ask()`.

---

## Model version picker

The model field in Settings is now a two-part widget:

- `<select id="model-picker">` — populated by `populateModelPicker(backend)` from
  `MODEL_CATALOGUE`. Includes a "✏️ Custom model ID…" sentinel at the bottom.
- `<input id="model">` — hidden by default; shown when the user picks Custom or
  types a non-catalogue value.
- `<span id="model-custom-toggle">` — link to switch between picker and free-text.

`modelInput.value` is the source of truth for what gets sent to the API.
`populateModelPicker()` is called on boot and on every backend change.

---

## Mic transcription — key design decisions

### Why `lumen://` scheme (not `file://`)

Chromium's Web Speech API chunked-upload pipeline rejects `file://` origins
(`OnSizeReceived failed with Error: -2`). Registering `lumen://` as a
privileged secure standard scheme in `main.js` (before `app.ready`) gives the
renderer a proper secure origin and fixes the upload.

### Bounded restart policy (renderer.js `setupRecognition`)

```
MAX_ERROR_RESTARTS = 3
MIN_CLEAN_SESSION_MS = 1000
```

- `network` error → surface user-visible message, stop. Never restart.
- `not-allowed` / `service-not-allowed` → mic permission denied path (opens macOS System Settings on darwin).
- `no-speech` → ignored (no counter increment).
- Other errors → increment `consecutiveErrorRestarts`; if > MAX, stop with error message; otherwise back-off retry.
- Clean `onend` (no error, session ≥ MIN_CLEAN_SESSION_MS) → immediate restart (~60s rotation).

### Whisper pipeline

Audio captured via `MediaRecorder`, rotated using the stop-and-recreate
strategy (NOT `start(timeslice)` — mid-stream WebM fragments are not
decodable). Each chunk POSTs to the Whisper endpoint with the Groq key.

### Two capture channels (v0.9)

Capture runs on two independent channels, `micChannel` ("you", `getUserMedia`)
and `sysChannel` ("them", `getDisplayMedia` loopback). Each owns its own
recorder, chunk sequence, ordering queue and silence meter — **sharing any of
those interleaves the two streams and scrambles both transcripts**.

Things that are load-bearing and easy to break:

- **`startSystemChannel` runs BEFORE `startMicChannel`.** `getDisplayMedia`
  needs a live user gesture; awaiting `getUserMedia` first spends it and the
  loopback request is then rejected.
- **The loopback video track is never stopped.** Stopping it ends the capture
  session on macOS and the audio dies with it — the recorder then yields empty
  blobs forever. Recording runs off `new MediaStream(audioTracks)` while the
  original capture stays open; `ch.captureStream` holds it for teardown.
- **macOS needs `MacLoopbackAudioForScreenShare` and
  `MacSckSystemAudioLoopbackOverride`** appended before `app.ready`, and the
  display-media handler must grant `audio: 'loopback'`.
- **Screen Recording permission gates all of this.** Denied,
  `getDisplayMedia` fails with "Error starting capture"; in other states it can
  return a live track carrying pure silence, indistinguishable from nobody
  speaking. Do not gate capture on `getMediaAccessStatus('screen')` — it
  reports stale `denied` for unsigned builds. Attempt the capture instead, and
  verify permission via the thumbnail-pixel check in `lumen:check-screen-perm`.

### Silence gate — adaptive, and fails open

Device levels differ by more than an order of magnitude: a built-in mic peaks
around 0.04 where a Bluetooth headset mic reads 0.000874 for the same speech.
A fixed threshold silently discarded every word from the quiet one.

- The floor follows `ch.noiseFloor` (×3), bounded below by `ABSOLUTE_FLOOR`
  and above by the configured value.
- A chunk also needs ≥8% of its window voiced, so a click or breath cannot
  clear the gate — near-silent audio is what makes Whisper invent phrases.
- **The gate only applies once `ch.meterOk` is true.** If the meter never
  produced a reading, its peak is stuck at 0 and gating on it would discard
  the entire session. Failing open costs a few wasted requests; failing closed
  costs everything.

### End-of-turn flushing

The meter flushes a chunk when speech stops (700ms quiet, ≥1.2s audio, ≥400ms
voiced) rather than when the interval expires. The interval is a **maximum**,
restarted on every flush — left running it fires just after an early flush and
emits a fragment of the next utterance.

### Transcript state

`transcriptEntries` holds attributed turns; `finalTranscript` remains the plain
concatenation so the Use/Append/Clear controls keep working. `transcriptCursor`
advances when text is taken, so nothing is picked up twice and the transcript
never needs clearing. Prompts default to the **them** channel only.

---

## Screenshot path

Uses `desktopCapturer` in the **main process** via `ipcMain.handle('lumen:capture-screen')`.
Does NOT use `getDisplayMedia` for one-shot screenshots. Reason: Electron 32 +
macOS ScreenCaptureKit's `SCContentSharingPicker` has a bug
("Collection was mutated while being enumerated") that crashes on the second
invocation. The main-process path bypasses the picker entirely.

Continuous screen share still uses `getDisplayMedia` (live stream, different code path).

---

## Conventions to follow

1. **Don't refactor for the sake of it.** `renderer.js` is intentionally one file.
2. **No new build tooling.** Source files load directly; no bundler.
3. **All state in `localStorage`.** No SQLite, no IndexedDB, no remote calls
   for preferences.
4. **`BrowserWindow.setContentProtection(true)` must stay on.** Removing it
   breaks the invisibility from screen capture.
5. **Vision model auto-swap.** When an image is attached, the request uses
   `VISION_DEFAULTS[backend]` regardless of the model input value.
6. **All animations are CSS-only.** There is a `prefers-reduced-motion` block
   at the bottom of the `<style>` that disables all animations.
7. **`node --check` + `npm test` before declaring any change done.**

---

## Current visual design (v0.9)

An **overlay**, not a window: a floating pill above a single centred glass
panel on a transparent, click-through page. The three-column dashboard
(sidebar / main / rightbar) is gone — the sidebar became the horizontal tab
strip at the head of the panel, and the rightbar's sections moved into the
panes they belong to (Screen Mode → Ask-from-Screen, Recent → History).

Palette is unchanged: violet (#8b5cf6) + cyan (#22d3ee) on near-black
(#09090f), glass surfaces, 10–24px radii.

Structural rules that are load-bearing:

- **The window is sized by the user; the content fills it.** Do NOT resize the
  window to fit content — that overrides every manual resize (dragging an edge
  springs back) and caps the chat log. `fitWindowToContent` is only for
  collapse/expand.
- **Never cap `.panel-wrap` in `vh`.** The window height derives from the
  panel, so a viewport-relative cap is circular: collapsed, the window is
  ~40px tall and the cap computes to zero, so expanding can never grow back.
- **`pointer-events: none` does not make gaps click-through.** The OS window
  still swallows the click; `setIgnoreMouseEvents(.., {forward: true})` is what
  forwards it, driven from the renderer's pointer sampling.
- Depth comes from the hairline border and inset top highlight. Outer drop
  shadows are avoided because the window clips to the drawn bounds.
- One `--t-fast` (140ms) transition token; hover lift is deliberately absent on
  dense controls, where it makes neighbours look misaligned.

---

## Testing

```sh
cd lumen
node --check main.js
node --check preload.js
node --check renderer/renderer.js
npm test
```

All tests must pass. Never delete a test to make it pass.

---

## Hotkeys (already wired)

| Shortcut | Action |
|---|---|
| `⌘⇧Space` | Toggle window |
| `⌘⇧L` | Focus input |
| `⌘⇧T` | Click-through mode |
| `⌘⇧O` | Cycle opacity |
| `⌘⇧↑↓←→` | Move window |
| `⌘⇧M` | Start / stop listening |
| `⌘⇧U` | Put their latest speech in the input |
| `⌘⇧⏎` | Ask about their latest speech immediately |
| `⌘⇧K` | Clear the transcript |
| `⌘⇧H` | Collapse / expand the panel |
| `⌘⏎` | Send |
| `⌘K` | Clear chat |
| `⌘+` / `⌘-` | Chat font size |
| `⌘0` | Reset font size |
| `?` | Hotkeys dialog |
| `Esc` | Close dialog / cancel |

---

## Common change → where to look

| Change | File(s) |
|---|---|
| New LLM backend | `renderer.js` — add to `MODEL_CATALOGUE`, `TEXT_DEFAULTS`, `VISION_DEFAULTS`, `VISION_HINTS`, `syncRows()`, `check()`, new `streamXxx()`, `ask()`. `index.html` — add `<option>` to `<select id="backend">` |
| New model version | `renderer.js` — add to `MODEL_CATALOGUE[backend]` array |
| New quick action | `renderer.js` — `SUGGESTION_PROMPTS`; `index.html` — `.sugg` card |
| Tweak system / negative prompt | `renderer.js` — `systemPrompt()` and `DEFAULT_NEGATIVE_PROMPT` |
| Add Settings field | `index.html` — row in `#pane-settings`; `renderer.js` — load/save to `localStorage` |
| Change colors / spacing | `index.html` — `:root` CSS variables in `<style>` (current theme: purple/violet + cyan glassmorphism with animated gradient orbs) |
| New global hotkey | `main.js` — `registerHotkeys()`; add row to hotkeys modal in `index.html` |

---

## How to publish a new release

```sh
# 1. Bump version in package.json
# 2. Rebuild
npm run dist
# 3. Commit + push source
git add -A
git commit -m "Release v0.x.y — describe changes"
git push
# 4. Create GitHub release with dmgs attached
gh release create v0.x.y dist/Lumen-0.x.y-arm64.dmg dist/Lumen-0.x.y.dmg \
  --title "Lumen 0.x.y" --notes "What changed"
```

---

## Out of scope (don't do unless explicitly asked)

- Code signing / notarization (requires Apple Developer Program)
- Server-side license validation
- Cross-platform Windows / Linux builds (config exists but untested)
- Telemetry, analytics, crash reporting (privacy promise)
- Persistent chat history across launches
- Replacing Web Speech with local Whisper for transcription (separate spec exists)

---

## When the user says "fix it" or "make it work"

The user is non-technical. Steps:

1. Read the actual error / screenshot carefully. Don't guess.
2. Look at the relevant file. The codebase is small; you can read it end-to-end.
3. Make the smallest change that fixes it. Don't refactor.
4. Run `node --check` on touched files and `npm test` before declaring done.
5. Reply with: what you changed + what command the user should run to test.

That's it. Welcome to Lumen.
