# Lumen

A privacy-first AI overlay assistant for macOS. Always-on-top, hidden from
screen capture, BYOK (bring your own LLM key).

Inspired by Cluely. Plain Electron + HTML/JS — no React, no build pipeline.

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
| `lumen.whisper.chunkSeconds` | Chunk duration in seconds (1–30) |
| `lumen.whisper.silenceRms` | RMS silence threshold (0–1, default 0.018) |

Edit any of these in DevTools console while the app is running.

---

## Project layout

```
lumen/
├── main.js                 # Electron main process
├── preload.js              # IPC bridge (window.lumen.*)
├── renderer/
│   ├── index.html          # all UI markup + CSS
│   ├── renderer.js         # all renderer logic
│   └── avatar.png          # bottom-left avatar
├── tests/
│   ├── whisperHarness.js   # Whisper pipeline harness
│   ├── whisperPbt.test.js  # property-based tests
│   ├── whisperUnits.test.js# unit tests
│   └── opacityHarness.js   # opacity controller harness
├── build/                  # icon + entitlements
├── README.md               # this file
├── AI-HANDOFF.md           # paste-and-go context for AI assistants
└── package.json
```

---

## Letting AI modify this codebase

See **AI-HANDOFF.md**. Paste its contents at the start of any conversation
with Claude / ChatGPT / Cursor and the AI will know the project conventions.

---

## Credits

Built by Sonu Kumar — [LinkedIn](https://www.linkedin.com/in/sonu-kumar-99a860354)
