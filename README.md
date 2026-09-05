# Lumen

A privacy-first AI overlay assistant for macOS. Always-on-top, hidden from
screen capture, BYOK (bring your own LLM key).

Inspired by Cluely. Plain Electron + HTML/JS — no React, no build pipeline.

---

## What's new in v0.9.0

### Hears both sides of a conversation

Capture now runs on **two independent channels**, and the transcript labels
who said what:

| Channel | Source | Label |
|---|---|---|
| Microphone | `getUserMedia` | **You** |
| System audio | `getDisplayMedia` loopback | **Them** |

A microphone alone cannot separate the two: on speakers it picks up the other
participant bleeding out of them mixed with your own voice, and on headphones
it cannot hear them at all. System audio is tapped before it reaches any
output device, so each channel stays clean.

> **macOS requires Screen Recording permission for this** — loopback runs
> through ScreenCaptureKit, which that permission gates. The microphone
> permission does not cover it. Without it the Them channel stays silent.
> Enable Lumen under System Settings → Privacy & Security → Screen Recording,
> then quit and reopen.

### No more clearing the transcript

Taking text advances a cursor instead of emptying the log, so the same words
are never picked up twice. Their speech also **auto-fills the composer** as
they talk, and clears itself when you start answering — the question is stale
once you are replying to it. Prompts draw from the **Them** channel only:
mixing both sides made the model answer the wrong half of the conversation.

### Transcription accuracy and latency

- **End-of-turn flushing** — a chunk is sent when speech stops rather than
  when a 5-second timer expires. Most of the old delay was spent watching a
  clock, and cutting on the gap between turns keeps whole utterances together,
  which transcribes better than slicing mid-sentence.
- **Adaptive silence gate** — the threshold follows each device's own noise
  floor. A fixed value tuned on a built-in mic discarded every word from a
  Bluetooth headset, whose level is ~20× quieter.
- **Input device picker** — pin a microphone so connecting headphones cannot
  move capture onto a headset mic that produces nothing.

### Keyboard control

| Shortcut | Action |
|---|---|
| `⌘⇧M` | Start / stop listening |
| `⌘⇧U` | Put their latest speech in the input |
| `⌘⇧⏎` | Ask about their latest speech immediately |
| `⌘⇧K` | Clear the transcript |
| `⌘⇧H` | Collapse / expand the panel |

### Overlay redesign

Floating pill above a single centred glass panel on a transparent,
click-through page — the window is sized to the drawn UI so no invisible
rectangle sits over the screen, and gaps forward clicks to whatever is behind.

### Diagnostics

`--audio-probe` runs the capture path and writes a staged report to
`~/lumen-audio-probe.json`: permission status, device list, track state, real
RMS, and whether MediaRecorder produces bytes. Every failure mode here is
invisible from the transcript — a missing permission still yields a live track
carrying pure silence — so it is measured rather than inferred.

```sh
open -a /Applications/Lumen.app --args --audio-probe
sleep 50 && cat ~/lumen-audio-probe.json
```

Also: **Electron 33.2.1**, GPT-OSS 120B/20B in the Groq picker, and 56 tests
(up from 25).

---

## What's new in v0.8.0

- **Major visual redesign**: Complete UI overhaul with glassmorphism aesthetic
  - Purple/violet + cyan color palette (replaces blue theme)
  - Animated floating gradient orbs in background
  - Glass panels with backdrop-filter blur throughout
  - Animated gradient text on greeting heading
  - Floating glass pill input bar with purple glow
  - Larger UI elements, more whitespace, bigger fonts
  - Staggered entrance animations on cards
  - Hover lift effects with glow shadows
  - Rounded corners (10–24px) everywhere
- **8 LLM backends**: Groq, Google Gemini, OpenAI, Claude (Anthropic), DeepSeek, Grok (xAI), Mistral AI, Ollama
- **Model version picker**: each backend now shows a dropdown of all known model versions — pick any version or type a custom model ID
- **Claude updated to Opus 4.8** (latest)
- **OpenAI**: GPT-4.1, GPT-4o, o1, o3, o4-mini and more
- **Grok 4** (xAI) with vision support
- **Mistral** with Pixtral vision models
- **mic transcription fix**: loaded from `lumen://` secure scheme — no more `chunked_data_pipe_upload_data_stream` errors
- **bounded restart policy**: network errors surface a user-visible message and stop retrying after 3 attempts instead of looping forever

---

## For end users — install the app

1. Download `Lumen-<version>-arm64.dmg` (Apple Silicon) or `Lumen-<version>.dmg`
   (Intel) from the **Releases** tab:
   https://github.com/sonukumar-87/lumen/releases
2. Double-click the dmg, drag **Lumen** to **Applications**.
3. The app is unsigned — first launch needs a one-time override:
   - **Right-click** Lumen in Applications → **Open** → click **Open** in the dialog.
   - Or run once in Terminal:
     ```sh
     xattr -dr com.apple.quarantine /Applications/Lumen.app
     ```
4. Open the **Settings** sidebar, pick your **backend** from the dropdown,
   paste your API key, click **Save key**, then **Check connection**.
5. Pick your model version from the **Model** dropdown (or type a custom ID).
6. Hit `⌘⇧Space` to toggle the overlay anytime.

---

## Supported backends

| Backend | Get API key | Default model | Vision |
|---|---|---|---|
| Groq | https://console.groq.com | llama-3.3-70b-versatile | ✅ llama-4-scout |
| Google Gemini | https://aistudio.google.com | gemini-2.0-flash-lite | ✅ gemini-2.0-flash |
| OpenAI | https://platform.openai.com | gpt-4.1 | ✅ gpt-4o |
| Claude (Anthropic) | https://console.anthropic.com | claude-opus-4-8 | ✅ |
| DeepSeek | https://platform.deepseek.com | deepseek-chat (V3) | ❌ API limitation |
| Grok (xAI) | https://console.x.ai | grok-4 | ✅ |
| Mistral AI | https://console.mistral.ai | mistral-large-latest | ✅ pixtral-large |
| Ollama | local | llama3.2 | ✅ llava |

> **DeepSeek image note**: DeepSeek's public API does not expose vision input.
> Their website uses an internal pipeline unavailable via API key.

---

## For developers — running from source

### Prerequisites

- macOS (Apple Silicon or Intel)
- Node.js 18+ (`brew install node`)
- Xcode Command Line Tools (`xcode-select --install`)

### Setup

```sh
git clone https://github.com/sonukumar-87/lumen.git
cd lumen
./setup.sh         # idempotent installer
npm test           # tests should pass
npm run dev        # launch with logging
```

### Make a code change

1. Edit `renderer/index.html` (UI) or `renderer/renderer.js` (logic).
2. Save. Hit `⌘R` inside the app to reload (no restart needed for renderer changes).
3. For `main.js` or `preload.js` changes, quit (`Ctrl+C`) and re-run `npm run dev`.

### Build a `.dmg`

```sh
# Bump version in package.json first

npm run dist         # both arm64 + x64
npm run dist:arm     # Apple Silicon only
npm run dist:intel   # Intel only
```

Outputs land in `dist/Lumen-<version>-<arch>.dmg`.

### Push code changes to GitHub

```sh
git add -A
git commit -m "describe your change"
git push
```

### Upload a new release to GitHub

```sh
gh release create v0.7.0 dist/Lumen-0.7.0-arm64.dmg dist/Lumen-0.7.0.dmg \
  --title "Lumen 0.7.0" --notes "Describe what changed"
```

---

## Hotkeys

| Shortcut | Action |
|---|---|
| `⌘⇧Space` | Toggle Lumen window |
| `⌘⇧L` | Focus the input |
| `⌘⇧T` | Click-through mode |
| `⌘⇧O` | Cycle opacity (100 → 70 → 40) |
| `⌘⇧↑↓←→` | Move window |
| `⌘⇧M` | Start / stop listening |
| `⌘⇧U` | Put their latest speech in the input |
| `⌘⇧⏎` | Ask about their latest speech immediately |
| `⌘⇧K` | Clear the transcript |
| `⌘⇧H` | Collapse / expand the panel |
| `⌘⏎` | Send message |
| `⌘K` | Clear chat |
| `⌘+` / `⌘-` | Increase / decrease chat font size |
| `⌘0` | Reset chat font size |
| `?` | Show hotkeys dialog |
| `Esc` | Close dialog / cancel screenshot |

---

## Configuration via localStorage

All preferences are stored locally inside Electron's per-app `userData`.

| Key | Description |
|---|---|
| `lumen.backend` | `echo` / `groq` / `gemini` / `openai` / `claude` / `deepseek` / `grok` / `mistral` / `ollama` |
| `lumen.model.<backend>` | Model name per backend |
| `lumen.key.<backend>` | API key per backend |
| `lumen.opacity` | Last opacity (20–100) |
| `lumen.chatZoom` | Chat font size (px) |
| `lumen.translateLang` | Default target language for Translate quick action |
| `lumen.negativePrompt` | Custom "what to avoid" guidance for the AI |
| `lumen.coffeeUrl` | Override Buy-Me-a-Coffee URL |
| `lumen.whisper.endpoint` | Override Whisper transcription endpoint |
| `lumen.whisper.model` | Override Whisper model |
| `lumen.whisper.chunkSeconds` | Maximum chunk duration in seconds (1–30). A chunk is normally flushed earlier, when speech stops. |
| `lumen.whisper.silenceRms` | Upper bound on the silence threshold (0–1, default 0.018). The gate adapts below this to each device's own noise floor, so a quiet Bluetooth mic is not gated out. |
| `lumen.capture.systemAudio` | `0` disables the Them channel (system audio) |
| `lumen.capture.micDeviceId` | Pinned input device; empty follows the system default |
| `lumen.capture.autoFill` | `0` stops their speech auto-filling the composer |
| `lumen.panelCollapsed` | `1` if the panel was collapsed when last closed |

Edit any of these in DevTools console while the app is running.

---

## Project layout

```
lumen/
├── main.js                 # Electron main process
├── preload.js              # IPC bridge (window.lumen.*)
├── audio-probe.js          # --audio-probe capture diagnostic
├── renderer/
│   ├── index.html          # all UI markup + CSS
│   ├── renderer.js         # all renderer logic
│   ├── probe.html          # page the audio probe runs
│   └── avatar.png          # avatar shown in Settings
├── tests/
│   ├── whisperHarness.js       # Whisper pipeline harness
│   ├── whisperPbt.test.js      # property-based tests
│   ├── whisperUnits.test.js    # unit tests
│   ├── captureChannels.test.js # two-channel capture + window behaviour
│   └── opacityHarness.js       # opacity controller harness
├── build/                  # icon + entitlements
├── README.md               # this file
├── AI-HANDOFF.md           # paste-and-go context for AI assistants
└── package.json
```

`renderer.js` cannot be imported by tests — it is a browser script with DOM and
Electron dependencies — so several tests read it as source and execute
individual functions extracted from it. That is why some assertions look
structural; see the comments in `captureChannels.test.js`.

---

## Letting AI modify this codebase

See **AI-HANDOFF.md**. Paste its contents at the start of any conversation
with Claude / ChatGPT / Cursor and the AI will know the project conventions.

---

## Credits

Built by Sonu Kumar — [LinkedIn](https://www.linkedin.com/in/sonu-kumar-99a860354)
