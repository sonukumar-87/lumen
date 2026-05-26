# Lumen — AI assistant handoff

Paste this entire file (or upload it as an attachment) at the start of any
new conversation with Claude / Cursor / ChatGPT / Copilot when you want
help modifying Lumen. The AI will know the project without you having to
re-explain.

---

## What Lumen is

Lumen is a privacy-first AI overlay assistant for macOS, built with
Electron. It floats above all windows, is hidden from screen capture
(`setContentProtection(true)`), and provides:

- **Chat** with multiple LLM backends (Groq, Gemini, Ollama, Echo)
- **Mic transcription** via Groq Whisper (`whisper-large-v3`)
- **Screenshot to AI** — capture, optionally crop, attach to next prompt
- **Continuous screen share** for live frame attachment
- **Image attachment** from disk
- **Quick actions** (Summarize, Explain, Translate, Improve)
- **Custom negative prompting** (configurable in Settings)
- **See-through opacity** (slider 20-100% + `⌘⇧O` cycle)
- **License gate** (invite-only via SHA-256 hashed keys)

Repo: https://github.com/sonukumar-87/lumen

---

## Tech stack — strict constraints

- **Electron 32** (don't downgrade or upgrade without user approval)
- **Plain HTML / CSS / JS** — NO React, NO Vue, NO Svelte, NO Tailwind, NO
  build pipeline. Just edit `renderer/index.html` and `renderer/renderer.js`
  and reload.
- **vitest + fast-check** for tests (already in `devDependencies`)
- **electron-builder** for packaging
- No new dependencies should be added without explicit user approval.

---

## File layout

```
lumen/
├── main.js                 # Electron main: window, hotkeys, IPC handlers,
│                             desktopCapturer, opacity tween, license-gated nothing.
├── preload.js              # contextBridge IPC bridge → window.lumen.*
├── renderer/
│   ├── index.html          # ALL UI MARKUP + CSS in one file (intentional).
│   ├── renderer.js         # ALL renderer logic in one file (intentional).
│   └── avatar.png          # bottom-left avatar image
├── tests/
│   ├── whisperHarness.js   # pure JS reimplementation of the Whisper pipeline
│   ├── whisperPbt.test.js  # property tests via fast-check
│   ├── whisperUnits.test.js# unit tests
│   └── opacityHarness.js   # pure JS opacity controller harness
├── build/
│   ├── icon.icns           # generated app icon
│   ├── raw-icon.jpg        # source image
│   ├── entitlements.mac.plist
│   ├── make-icon.sh
│   └── build-icon-from-raw.sh
├── package.json
├── README.md               # full developer + end-user docs
└── AI-HANDOFF.md           # this file
```

---

## Conventions to follow when changing code

1. **Don't refactor for the sake of it.** Lumen deliberately keeps
   `renderer.js` as one file. Don't split into modules unless the user
   asks for it.

2. **Don't introduce new build tooling.** No webpack, no esbuild, no
   bundler. Source files load directly via `<script src="./renderer.js">`.

3. **All state in `localStorage`.** No SQLite, no IndexedDB, no remote
   backend. List of recognized keys is in README.md.

4. **Whisper pipeline is request/response.** Audio is captured via
   `MediaRecorder`, sliced into ~5s chunks via the rotate-the-recorder
   strategy (NOT `start(timeslice)` — that produces non-decodable mid-stream
   WebM fragments). Each chunk POSTs to a Whisper endpoint with the user's
   Groq key.

5. **Screenshot path uses `desktopCapturer` (in main process), NOT
   `getDisplayMedia` (in renderer).** Reason: Electron 32 + macOS
   ScreenCaptureKit's `SCContentSharingPicker` has a bug ("Collection was
   mutated while being enumerated") that crashes on the second invocation.
   Bypassing the picker via `desktopCapturer.getSources` avoids it.

6. **Vision model auto-swap.** When an image is attached to an Ask, the
   request body uses a vision-capable model regardless of what's in the
   `model` input. See `VISION_DEFAULTS` in `renderer.js`.

7. **The renderer is loaded from a custom `lumen://` privileged secure
   scheme**, registered in `main.js`. NOT `file://`. This was required
   because Chromium 128's chunked-upload pipeline rejected `file://`.

8. **`BrowserWindow.setContentProtection(true)` must stay on.** This is
   the "invisibility trick" — excludes the window from screen capture.

9. **License gate runs first in `renderer.js`.** Modifying it without
   user approval is out of scope. Hashes are SHA-256(salt + key); plaintext
   keys are NOT in source.

10. **All animations are CSS-only.** No Framer Motion, no GSAP. There is a
    `prefers-reduced-motion` media query block at the bottom of the
    stylesheet that disables every animation.

---

## Testing — REQUIRED before declaring success

After ANY change:

```sh
cd lumen
node --check main.js
node --check preload.js
node --check renderer/renderer.js
npm test
```

All 25 tests must pass. If they don't, fix the tests OR fix the code, but
never silently delete a test to make it pass.

---

## Hotkeys (already wired — don't redefine without user approval)

| Shortcut | Action |
| --- | --- |
| `⌘⇧Space` | Toggle window |
| `⌘⇧L` | Focus input |
| `⌘⇧T` | Click-through mode |
| `⌘⇧O` | Cycle opacity |
| `⌘⇧↑↓←→` | Move window |
| `⌘⏎` | Send |
| `⌘K` | Clear chat |
| `?` | Hotkeys dialog |
| `Esc` | Close dialog / cancel |

When adding new hotkeys, register them in `main.js` `registerHotkeys()` and
add a row to the hotkeys modal in `renderer/index.html`.

---

## Common change request → where to look

| Change | File(s) |
| --- | --- |
| New chat backend | `renderer.js` — copy `streamGroq` pattern, register in `ask()` and the AI Model dropdown in `index.html` |
| New quick action | `renderer.js` — add to `SUGGESTION_PROMPTS`; add a `.sugg` card in `index.html` |
| Tweak system prompt / negative prompt defaults | `renderer.js` — `systemPrompt()` and `DEFAULT_NEGATIVE_PROMPT` |
| Add Settings field | `index.html` — new row inside `#pane-settings`; `renderer.js` — load/save to `localStorage` |
| Change colors / spacing | `index.html` — `<style>` block at the top, `:root` CSS variables |
| Add a new license key | Generate in terminal (see README.md), hash it, paste hash into `LICENSE_HASHES` |
| New global hotkey | `main.js` — `registerHotkeys()`; preload bridge if it needs renderer notification; hotkeys modal in `index.html` |

---

## How to publish a new release

```sh
# 1. Bump version in package.json
# 2. Rebuild
npm run dist
# 3. Commit + push
git add -A
git commit -m "Release v0.x.y"
git push
# 4. Create a GitHub release with the dmgs attached
gh release create v0.x.y dist/Lumen-0.x.y-arm64.dmg dist/Lumen-0.x.y.dmg \
  --title "Lumen 0.x.y" --notes "What changed"
```

---

## Out of scope (don't do unless explicitly asked)

- Code signing / notarization (requires Apple Developer Program, $99/year)
- Server-side license validation (would require hosting infrastructure)
- Cross-platform Windows / Linux builds (config exists but untested)
- Telemetry, analytics, crash reporting (privacy promise)
- Persistent chat history across launches (separate spec)
- Region screenshot via custom OS-level overlay (Electron limitations)

---

## When the user says "fix it" or "make it work"

The user is non-technical. They will paste error messages or describe
behavior. Don't make them debug. Steps:

1. **Read the actual error / screenshot carefully.** Don't guess.
2. **Look at the relevant file.** The codebase is small; you can read it
   end-to-end in a few minutes.
3. **Make the smallest change that fixes it.** Don't refactor.
4. **Run `node --check` on touched files and `npm test` before declaring
   done.**
5. **Reply with exactly two things**: what you changed and what command
   the user should run to test it.

That's it. Welcome to Lumen.
