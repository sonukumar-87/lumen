# Lumen

A privacy-first AI overlay assistant for macOS. Always-on-top, hidden from
screen capture, BYOK (bring your own LLM key), invite-only via license keys.

Inspired by Cluely. Plain Electron + HTML/JS — no React, no build pipeline.

---

## For end users — install the app

1. Download `Lumen-<version>-arm64.dmg` (Apple Silicon) or `Lumen-<version>.dmg`
   (Intel) from the **Releases** tab on this repo:
   https://github.com/sonukumar-87/lumen/releases
2. Double-click the dmg, drag **Lumen** to **Applications**.
3. The app is unsigned, so the first launch needs a one-time override:
   - **Right-click** Lumen in Applications → **Open** → click **Open** in the
     dialog. (Don't double-click the first time.)
   - Or run once in Terminal:
     ```sh
     xattr -dr com.apple.quarantine /Applications/Lumen.app
     ```
4. On first launch, enter your **license key** (4-block format `LUM-XXXX-XXXX-XXXX`).
   Contact the developer if you don't have one.
5. Open the **Settings** sidebar item, paste your **Groq / Gemini API key**,
   click **Save key**, then **Check connection**.
6. Hit `⌘⇧Space` to toggle the overlay anytime.

---

## For developers — running from source

### Prerequisites

- macOS (works on Apple Silicon and Intel)
- Node.js 18+ (`brew install node`)
- Xcode Command Line Tools (`xcode-select --install`)

### Setup

```sh
git clone https://github.com/sonukumar-87/lumen.git
cd lumen
./setup.sh         # idempotent installer; handles a known Electron postinstall bug
npm test           # 25 tests should pass
npm run dev        # launch with logging
```

### Make a code change

1. Edit `renderer/index.html` (UI) or `renderer/renderer.js` (logic).
2. Save. Hit `⌘R` inside the app to reload (no restart needed for renderer
   changes).
3. For `main.js` or `preload.js` changes, fully quit (`Ctrl+C`) and re-run
   `npm run dev`.

### Build a `.dmg`

```sh
# Bump the version first
# (edit "version" in package.json)

npm run dist         # builds both arm64 + x64
npm run dist:arm     # Apple Silicon only
npm run dist:intel   # Intel only
```

Outputs go to `dist/Lumen-<version>-<arch>.dmg`.

### Replace the app icon

Drop a square image at `build/raw-icon.png` (or `.jpg`), then:

```sh
./build/build-icon-from-raw.sh
npm run dist
```

### Push code changes to GitHub

```sh
git add -A
git commit -m "describe your change"
git push
```

### Upload a new dmg release to GitHub

DMG files are too big for git. Use **GitHub Releases** instead:

1. Build the dmgs: `npm run dist`.
2. Go to https://github.com/sonukumar-87/lumen/releases/new
3. **Tag**: `v0.3.0` (or whatever version you bumped to in `package.json`).
4. **Title**: `Lumen 0.3.0`.
5. **Description**: short notes on what changed.
6. **Drag and drop** both `dist/Lumen-0.3.0-arm64.dmg` and
   `dist/Lumen-0.3.0.dmg` into the **Attach binaries** area.
7. Click **Publish release**.

End users will see the new version under the Releases tab and can download
the dmg directly.

**Or via CLI** (after `brew install gh && gh auth login`):

```sh
gh release create v0.3.0 dist/Lumen-0.3.0-arm64.dmg dist/Lumen-0.3.0.dmg \
  --title "Lumen 0.3.0" --notes "Describe your changes here"
```

---

## License keys

Lumen is invite-only. Valid keys are SHA-256 hashed and listed in
`renderer/renderer.js` (`LICENSE_HASHES`). The plaintext keys are not in
source.

### Generate new keys

```sh
node -e "const c=require('crypto'); for(let i=0;i<5;i++){let p=Array.from({length:3},_=>c.randomBytes(2).toString('hex').toUpperCase()).join('-');console.log('LUM-'+p);}"
```

Save the keys somewhere safe.

### Hash them and add to `renderer.js`

```sh
node -e "const c=require('crypto'); const salt='lumen-v1-salt-92Xk7pQz'; const keys=['LUM-XXXX-XXXX-XXXX','...']; for(const k of keys) console.log(c.createHash('sha256').update(salt+k).digest('hex'));"
```

Paste the resulting hashes into the `LICENSE_HASHES` Set near the top of
`renderer/renderer.js`. Rebuild and ship.

### Revoke a key

Remove its hash from `LICENSE_HASHES`, rebuild, ship a new dmg. Note:
existing users with the key cached in localStorage will still work until
they reinstall — true server-side revocation requires a separate license
server (not implemented).

---

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

---

## Configuration via localStorage

All preferences are stored locally inside Electron's per-app `userData`.

| Key | Description |
| --- | --- |
| `lumen.license` | Validated license key |
| `lumen.backend` | `echo` / `groq` / `gemini` / `ollama` |
| `lumen.model.<backend>` | Model name per backend |
| `lumen.key.<backend>` | API key per backend |
| `lumen.opacity` | Last opacity (20-100) |
| `lumen.translateLang` | Default target language for the Translate quick action |
| `lumen.negativePrompt` | Custom "what to avoid" guidance for the AI |
| `lumen.coffeeUrl` | Override Buy-Me-a-Coffee URL |
| `lumen.whisper.endpoint` | Override Whisper endpoint |
| `lumen.whisper.model` | Override Whisper model |
| `lumen.whisper.chunkSeconds` | Chunk duration (1-30 seconds) |

Edit any of these in DevTools console while the app is running.

---

## Project Layout

```
lumen/
├── main.js                 # Electron main process
├── preload.js              # IPC bridge
├── renderer/
│   ├── index.html          # all UI markup + CSS
│   ├── renderer.js         # all renderer logic
│   └── avatar.png          # bottom-left avatar
├── tests/                  # vitest + fast-check
├── build/                  # icon + entitlements
├── README.md               # this file
├── AI-HANDOFF.md           # paste-and-go context for Claude/Cursor/etc.
└── package.json
```

---

## Letting AI modify this codebase

See **AI-HANDOFF.md** in this repo. Paste its contents at the start of any
new conversation with Claude / Cursor / ChatGPT and the AI will know the
project conventions without needing to be re-briefed.

---

## Credits

Built by Sonu Kumar — [LinkedIn](https://www.linkedin.com/in/sonu-kumar-99a860354).
