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

Audio captured via `MediaRecorder`, rotated every N seconds (default 5) using
the stop-and-recreate strategy (NOT `start(timeslice)` — mid-stream WebM
fragments are not decodable). Each chunk POSTs to Whisper endpoint with Groq key.
RMS silence detection (`analyserNode`) skips chunks below threshold (default 0.018)
to suppress hallucinations on silent audio.

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

## Current visual design (v0.8)

The UI uses a **glassmorphism** aesthetic with:
- **Color palette**: Purple/violet (#8b5cf6) + cyan (#22d3ee) accents on a near-black base (#09090f)
- **Animated gradient orbs**: Floating radial gradients that slowly animate behind all content
- **Glass panels**: Sidebar, header, rightbar, status bar use `backdrop-filter:blur(20px)` with semi-transparent backgrounds
- **Animated gradient heading**: The greeting text shimmers with a moving gradient (purple → cyan)
- **Floating input bar**: Command bar is a glass pill with purple glow border, no hard attachment to edges
- **Large UI elements**: 14px base font, 38px avatars, generous padding/whitespace
- **Card hover effects**: Elements lift with translateY + scale + purple glow shadows on hover
- **Rounded corners**: 10–24px radius throughout (no sharp corners anywhere)
- **Gradient brand mark**: Purple → cyan rounded square logo
- **Glowing status indicators**: Double-layered box-shadow glows on all status dots
- **Staggered entrance animations**: Suggestion cards and messages animate in with cubic-bezier timing

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
