# UI Polish + See-Through — How to Test

This is a manual visual / hardware-dependent checklist that complements
`npm test` (which runs the automated property and unit tests).

## What changed

Three coordinated changes:
- **See-through opacity toggle** with button + `⌘⇧O` hotkey, cycling 100% → 70% → 40% → 100%
- **UI polish**: collapsible settings, consistent button styles, native tooltips, transcript actions toolbar
- **CSS animations**: chat bubble fade-in, button hover, settings expand, typing pulse, transcribing shimmer, opacity tween

All animations respect `prefers-reduced-motion: reduce`.

## Step 1 — Run automated tests

```sh
cd "/Users/maheshkumar/untitled folder/sonu/lumen"
npm test
```

Whisper tests should still all pass (they were unchanged).

## Step 2 — Launch the app

```sh
cd "/Users/maheshkumar/untitled folder/sonu/lumen"
npm run dev
```

## Step 3 — Verify the see-through cycle (button)

1. Look at the title bar — you should see a `100%` opacity badge alongside the eye/ear/click-through badges.
2. Look at the command panel — you should see an opacity button between Listen and Clear, currently labeled `100%`.
3. Click the opacity button. The whole window should fade smoothly to 70% over ~200ms. Both the badge and the button now show `70%`.
4. Click again — fade to 40%.
5. Click again — fade back to 100%.

## Step 4 — Verify the hotkey

Press `⌘⇧O` (mac) or `Ctrl+Shift+O` (win/linux). Same cycle as the button.

## Step 5 — Persistence across restart

1. Set opacity to 70%.
2. Quit the app fully (`⌘Q` on mac).
3. Relaunch with `npm run dev`.
4. The opacity badge and button should both show `70%` on launch — the level was remembered.

## Step 6 — Settings panel collapse

1. Look at the backend settings — they should be collapsed by default on first launch.
2. Click the "Backend settings" header (the summary). The panel expands smoothly over ~250ms.
3. Click again. Panel collapses smoothly.
4. Quit and relaunch. The panel returns in whatever state you left it.

## Step 7 — Tooltips

Hover each button without clicking. After ~1 second, a native OS tooltip should appear:
- Send button: shows `Send (Cmd+Enter)` or `(Ctrl+Enter)`
- Opacity button: shows `Cycle opacity (Cmd+Shift+O)` or `(Ctrl+Shift+O)`
- All other buttons: a plain-English action description

## Step 8 — Typing indicator + chat fade

1. Click 🎤 Listen and speak (or just type a prompt).
2. Send. The assistant bubble should appear with three dots pulsing while waiting for the first token.
3. As soon as the first token arrives, the dots disappear and the streamed text takes over.
4. The new chat bubbles should fade in smoothly.

## Step 9 — Transcribing shimmer

1. Click 🎤 Listen. Speak.
2. While a Whisper chunk is uploading (status line says `transcribing…`), the transcript panel background should have a subtle moving shimmer.
3. When the response comes back and status returns to `listening…`, the shimmer stops.

## Step 10 — Coexistence with content protection

1. Set opacity to 70%.
2. Take an OS screenshot (`⌘⇧4` on mac → drag selection over Lumen).
3. Open the screenshot. Lumen should NOT appear in it — content protection still works at reduced opacity.

## Step 11 — Coexistence with click-through and screen share

1. Press `⌘⇧T` to toggle click-through. The click-through badge should change. Opacity stays put.
2. Click 📷 Share screen. Opacity stays put.
3. Click 🎤 Listen. Opacity stays put.

This confirms opacity is strictly user-driven (no auto-trigger from any other state).

## Step 12 — Reduced motion

1. macOS: System Settings → Accessibility → Display → Reduce motion → ON.
2. Click the opacity button. The opacity changes INSTANTLY (no fade).
3. Toggle the settings panel. Expands/collapses INSTANTLY.
4. The state still changes — only the animations are suppressed.
5. Turn Reduce motion OFF when done.

## What's left

Three remaining specs from your roadmap:
- **Screenshot-to-AI workflow** (region select → instant Ask)
- **Multi-monitor support** (DPI scaling, monitor switching, fullscreen-app handling)
- **Other backlog**: system-audio transcription, custom screen-share picker, persistent chat history

When ready, just say which one to start.

## If something goes wrong

- **Opacity button missing**: hard-refresh the renderer (DevTools → Cmd+Shift+R) to bust any cached HTML.
- **Hotkey doesn't fire**: another app may have grabbed `⌘⇧O`. Check the terminal for `[lumen] could not register: CommandOrControl+Shift+O`.
- **Animations look choppy**: check System Settings → Reduce Motion is OFF. If still choppy, GPU acceleration may be off.
- **Settings panel won't expand**: open DevTools console, look for errors. The summary click handler may have failed to bind.
- **Tests fail**: paste the failure output. Don't proceed to live testing until tests are green.
