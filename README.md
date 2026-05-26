# Lumen

A privacy-first AI overlay assistant for macOS. Always-on-top, hidden from
screen capture, BYOK (bring your own LLM key), nothing phones home except the
backend you choose.

Inspired by Cluely. Built with Electron + plain HTML/JS — no React, no
build pipeline, just edit and reload.

## Features

- **Chat backends**: Groq (fast, free tier), Google Gemini, Ollama (local), Echo (test mode). Streaming responses on all real backends.
- **Mic transcription** via Groq Whisper (`whisper-large-v3`). Audio chunked every 5s, transcripts append in order.
- **Screenshot to AI**: capture full screen → optional drag-to-crop → attach to next prompt. Auto-routes to a vision-capable model.
- **Continuous screen share** for live frame attachment on every Ask.
- **Attach image** from disk via the Attach pill.
- **Quick actions**: Summarize, Explain, Translate, Improve. Wraps your input or prefills it.
- **Negative prompting** — system prompt tells the AI what to avoid (configurable in Settings).
- **See-through opacity slider** (20–100%) plus `⌘⇧O` hotkey cycle.
- **Hidden from screen capture** via `BrowserWindow.setContentProtection(true)` — your overlay won't appear in QuickTime / Zoom / Meet recordings.
- **Always-on-top, visible across spaces and fullscreen apps.**
- **Custom hotkeys panel** (`?` opens it).

## Quick Start

```sh
git clone https://github.com/<YOUR_USERNAME>/lumen.git
cd lumen
./setup.sh         # idempotent installer; handles a known Electron postinstall bug
npm run dev        # launch in dev mode with logging
```

First-run setup inside the app:
1. Open the **Settings** sidebar item.
2. Pick a backend (Groq is recommended — free, fast).
3. Paste your API key, click **Save key**, then **Check connection**.
4. Click 🎤 Listen, 📷 Screenshot, 🖥 Share, or just type.

## Project Layout

```
lumen/
├── main.js                 # Electron main process (window, hotkeys, IPC)
├── preload.js              # window.lumen IPC bridge for the renderer
├── renderer/
│   ├── index.html          # all UI markup + CSS in one file
│   ├── renderer.js         # all renderer logic (chat, mic, capture, opacity)
│   └── avatar.png          # bottom-left avatar image
├── tests/
│   ├── whisperHarness.js   # pure-JS reimplementation of Whisper_Client for tests
│   ├── whisperPbt.test.js  # property-based tests (fast-check)
│   └── whisperUnits.test.js# unit tests
├── build/
│   ├── icon.icns           # generated macOS app icon
│   ├── raw-icon.jpg        # source image for the icon
│   ├── entitlements.mac.plist
│   └── build-icon-from-raw.sh
├── package.json
└── setup.sh                # one-shot installer
```

## Hotkeys

| Shortcut | Action |
| --- | --- |
| `⌘⇧Space` | Toggle Lumen window |
| `⌘⇧L` | Focus the input |
| `⌘⇧T` | Click-through mode |
| `⌘⇧O` | Cycle opacity (100 → 70 → 40) |
| `⌘⇧↑↓←→` | Move window |
| `⌘⏎` | Send message |
| `⌘K` | Clear chat |
| `?` | Show hotkeys dialog |
| `Esc` | Close dialog / cancel screenshot |

## Development

### Run in dev mode

```sh
npm run dev
```

Uses `electron . --enable-logging`. Logs go to the terminal that started it.
Reload the renderer with `⌘R` after changing `renderer/*` files. Restart the
app fully (`Ctrl+C` then re-run) after changing `main.js` or `preload.js`.

### Run tests

```sh
npm test
```

25 tests covering Whisper transcription, opacity controller, error funnel,
and reduced-motion behavior. Should be green before any release build.

### Make code changes

All UI lives in `renderer/index.html` and `renderer/renderer.js`. The whole
window is one HTML file with inline `<style>` and one JS file — no build
step, no bundler. Edit, save, reload (`⌘R` in the app).

Backend chat logic is in `renderer.js` under the `LLM BACKENDS` section.
Each backend (Groq / Gemini / Ollama) has its own `streamX` function. They
all share the system prompt from `systemPrompt(hasImage)` which reads the
user's negative prompt from `localStorage['lumen.negativePrompt']`.

Mic transcription pipeline is in the `WHISPER` sections of `renderer.js`.

The opacity controller lives at the top of `renderer.js` under
`Opacity_Controller`. Slider drives it directly; hotkey `⌘⇧O` cycles
through three discrete stops.

### Build a `.dmg`

```sh
npm run dist            # builds both arm64 + x64
npm run dist:arm        # Apple Silicon only
npm run dist:intel      # Intel only
```

Outputs go to `dist/Lumen-<version>-<arch>.dmg`. The build is **unsigned**.
On first launch users have to right-click → Open to bypass Gatekeeper, or
run `xattr -dr com.apple.quarantine /Applications/Lumen.app`.

### Replace the app icon

Drop a square image at `build/raw-icon.png` (or `.jpg`), then:

```sh
./build/build-icon-from-raw.sh
npm run dist
```

The script center-crops the image, generates the iconset at all required
sizes, and writes `build/icon.icns` for `electron-builder` to pick up.

### Bump version before each build

Edit `package.json` `"version"` field. The dmg filename includes the version.

## Configuration via localStorage

All preferences are stored locally. No remote sync, no telemetry.

| Key | Type | Description |
| --- | --- | --- |
| `lumen.backend` | string | Selected chat backend (`echo` / `groq` / `gemini` / `ollama`) |
| `lumen.model.<backend>` | string | Model name for each backend |
| `lumen.key.groq` | string | Groq API key (also used by Whisper) |
| `lumen.key.gemini` | string | Gemini API key |
| `lumen.opacity` | string | Last opacity (20-100) |
| `lumen.settings.expanded` | string | `"true"` / `"false"` |
| `lumen.whisper.endpoint` | string | Override Whisper endpoint |
| `lumen.whisper.model` | string | Override Whisper model |
| `lumen.whisper.chunkSeconds` | string | Chunk duration (1-30 seconds) |
| `lumen.translateLang` | string | Default target language for the Translate quick action |
| `lumen.negativePrompt` | string | What the AI should avoid in answers |
| `lumen.coffeeUrl` | string | Override Buy-Me-a-Coffee URL |

Edit any of these in DevTools console:

```js
localStorage.setItem('lumen.whisper.chunkSeconds', '3')
```

## Security model

- All keys live in renderer-local `localStorage` (i.e. inside Electron's
  per-app `userData` directory).
- The renderer is loaded from a custom `lumen://` privileged secure scheme,
  not `file://`. This was required because Chromium's chunked-upload
  pipeline (used by Web Speech API) rejected `file://` origins.
- `BrowserWindow.setContentProtection(true)` excludes the window from
  screen capture on macOS (`NSWindowSharingNone`) and Windows
  (`WDA_EXCLUDEFROMCAPTURE`).
- No analytics, no crash reporting, no remote logging.

## Known issues

1. macOS shows a screen-sharing menu bar icon and orange dot whenever
   `getDisplayMedia` or `desktopCapturer` is used. This is OS-level and
   cannot be hidden by any app. The Screenshot pill closes the stream
   immediately so the icon is brief; the Share pill keeps it open.
2. Unsigned dmg requires right-click → Open on first launch (or
   `xattr -dr com.apple.quarantine /Applications/Lumen.app`).
3. Groq rotates vision model IDs every few months. If "key works, model id
   not found", paste a current vision model ID into the Settings model
   field.

## Letting AI modify this codebase

If you want to hand the project to an AI tool (Claude, Cursor, etc.) for
modifications, point it at this README plus the four key files:

- `main.js` — Electron main process
- `preload.js` — IPC bridge
- `renderer/index.html` — all markup + styles
- `renderer/renderer.js` — all renderer logic

Tell the AI:

> The project is a plain Electron app (no React, no build pipeline). UI is
> one HTML file and one JS file. After any change, run `node --check` on
> the modified JS files and `npm test` from the `lumen/` directory before
> declaring success. Don't introduce new dependencies without checking.
> See README.md for the full architecture and key conventions.

## License

MIT (or whatever you prefer — currently unlicensed for personal use).

## Credits

Built by Sonu Kumar — [LinkedIn](https://www.linkedin.com/in/sonu-kumar-99a860354).
