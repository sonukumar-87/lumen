# Implementation Plan: UI Polish and See-Through

Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

## Overview

This plan implements three coordinated changes to Lumen's existing Electron app:

1. A user-controlled three-state Window_Opacity cycle (100% → 70% → 40% → 100%) driven by a new Opacity_Cycle_Button (`#opacity`) and a new global hotkey (`CommandOrControl+Shift+O`). The actual opacity is applied via `BrowserWindow.setOpacity` from `lumen/main.js` so the entire overlay (chrome plus content) goes see-through.
2. A polish pass on the existing renderer: collapse Settings_Panel by default, give every button a single shared `.btn` visual language, attach native `title=` tooltips with the right modifier per platform, and group transcript actions into a `.transcript-toolbar` above the transcript text.
3. CSS-only animations: chat bubble fade-in, button hover transition, settings panel expand/collapse, typing indicator pulse, transcribing shimmer, and an eased opacity tween in the main process. All animations honor `prefers-reduced-motion: reduce`.

The work proceeds in five layers:

1. **Test harness scaffold** — add `lumen/tests/opacityHarness.js` mirroring the patterns in `whisperHarness.js` so property + unit tests can drive the Opacity_Controller deterministically.
2. **Main + preload plumbing** — add the IPC handler, the tween driver, the global hotkey, and the two preload bridge methods.
3. **Renderer logic** — add the `Opacity_Controller` block, the settings-panel collapse handler, the typing indicator helper, the `setStatus` shimmer extension, and the title-attribute init helper.
4. **Renderer markup + CSS** — update `renderer/index.html` with the new badge, the new button, the `.settings-body` wrapper, the moved/renamed `.transcript-toolbar`, the `class="btn"` additions on all 11 buttons, and the new style rules + keyframes + reduced-motion overrides.
5. **Tests + manual checklist** — five property tests (P1–P5) in `lumen/tests/opacityPbt.test.js`, seven unit tests in `lumen/tests/uiPolishUnits.test.js`, and a new `lumen/UI-POLISH-TESTING.md` for the visual / hardware-dependent checks that can't be automated.

Property tests live next to the implementation they validate so failures surface early. Unit tests batch the example-classified acceptance criteria and run after the wiring is complete.

## Tasks

- [x] 1. Build the opacity test harness
  - [x] 1.1 Create `lumen/tests/opacityHarness.js`
    - Mirror the patterns in `lumen/tests/whisperHarness.js` (Map-backed `localStorage` shim, spy factory, single-export factory function)
    - Reimplement `OPACITY_LEVELS = [100, 70, 40]`, `OPACITY_KEY = 'lumen.opacity'`, `loadOpacity()`, `setOpacity(level)`, `cycleOpacity()`, `updateOpacityBadge()` as pure JS so property tests can drive them without DOM or Electron
    - Reimplement the settings-panel persistence helpers `loadSettingsExpanded()` and `applySettingsExpanded(expanded)` against the same localStorage shim under key `'lumen.settings.expanded'`
    - Mock `L.setOpacity(level, opts)` as a spy so tests can assert the wire payload (especially `{ instant }`)
    - Mock `window.matchMedia('(prefers-reduced-motion: reduce)')` as a configurable `{ matches }` returning function so tests can flip reduced-motion on/off mid-run
    - Expose `harness.cycleOpacity()`, `harness.setOpacity(level)`, `harness.loadOpacity()`, `harness.toggleSettings()`, `harness.getState()` (returns `{ currentOpacity, settingsExpanded, lastSetOpacityCall, setOpacityCalls, opacityBadgeText, mocks }`) plus a `harness.simulateUnrelatedEvent(name)` no-op stub used by P4 to exercise screen-share/click-through/Whisper toggles without touching opacity
    - Export `createOpacityHarness(opts)` where `opts` accepts `{ localStorage, reducedMotion, platform }`
    - _Requirements: 1.2, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.4, 7.1, 7.2_

- [x] 2. Main process: opacity IPC handler, tween driver, and global hotkey
  - [x] 2.1 Add `clampOpacity` helper and `ipcMain.on('lumen:set-opacity')` handler in `lumen/main.js`
    - Add module-scoped `let opacityTweenTimer = null;` and `let currentWindowOpacity = 1.0;`
    - Add `clampOpacity(level)` that maps `100 → 1.0`, `70 → 0.7`, `40 → 0.4`, and returns `1.0` for any other input (defense in depth — main never trusts the wire payload blindly)
    - Register `ipcMain.on('lumen:set-opacity', (_evt, payload) => { ... })`:
      - Read `target = clampOpacity(payload && payload.level)` and `instant = !!(payload && payload.instant)`
      - Cancel any in-progress tween via `clearInterval(opacityTweenTimer)` and null it
      - When `instant === true` or `target === currentWindowOpacity`: call `win.setOpacity(target)`, update `currentWindowOpacity`, return immediately
      - Otherwise drive a 12-step ease-out-cubic tween via `setInterval(stepFn, 200/12)` (~16.6 ms per step ≈ 60 fps): each step sets `next = start + (target - start) * (1 - (1 - t)^3)` with `t = i/12`; on the final step clear the interval and snap to the exact target via `win.setOpacity(target)` then update `currentWindowOpacity`
      - Guard every `win.setOpacity(...)` call with `if (win)` so a closed window mid-tween is a no-op
    - _Requirements: 1.6, 6.1, 6.2, 15.6, 17.1, 17.2, 17.3_

  - [x] 2.2 Register `CommandOrControl+Shift+O` in `registerHotkeys()` in `lumen/main.js`
    - Append `'CommandOrControl+Shift+O': () => { if (win) win.webContents.send('opacity-cycle'); }` to the existing `bindings` object inside `registerHotkeys()`
    - The existing failure path (collisions push the chord into `failed[]` and `console.warn('[lumen] could not register: ...')` runs) is reused — no new error handling is needed
    - Verify by source-grep that the new chord does not duplicate any of `CommandOrControl+Shift+Space`, `CommandOrControl+Shift+L`, `CommandOrControl+Shift+T`, `CommandOrControl+Shift+Up`, `CommandOrControl+Shift+Down`, `CommandOrControl+Shift+Left`, or `CommandOrControl+Shift+Right`
    - _Requirements: 2.1, 2.2, 2.4, 2.5_

- [x] 3. Preload bridge methods
  - [x] 3.1 Add `setOpacity` and `onOpacityCycle` to the `lumen` bridge in `lumen/preload.js`
    - Inside the existing `contextBridge.exposeInMainWorld('lumen', { ... })` block, add `setOpacity: (level, opts) => ipcRenderer.send('lumen:set-opacity', { level, instant: !!(opts && opts.instant) })`
    - Also add `onOpacityCycle: (cb) => ipcRenderer.on('opacity-cycle', () => cb())`
    - Do not import or expose any new Node API; the bridge only forwards the existing `ipcRenderer` channels
    - _Requirements: 1.6, 2.3, 6.1, 16.3_

- [x] 4. Renderer: Opacity_Controller module
  - [x] 4.1 Add the Opacity_Controller block in `lumen/renderer/renderer.js`
    - Inserted near the top of the file alongside the other module-scoped state, after the existing `let listening = false;` line
    - Define `const OPACITY_LEVELS = [100, 70, 40];`, `const OPACITY_KEY = 'lumen.opacity';`, `let currentOpacity = 100;`
    - Implement `loadOpacity()`: read `localStorage.getItem(OPACITY_KEY)`; return `Number(raw)` only when `raw === '100' | '70' | '40'`; otherwise overwrite storage with `'100'` and return `100`
    - Implement `setOpacity(level)`: short-circuit on `!OPACITY_LEVELS.includes(level)`; assign `currentOpacity = level`; write `String(level)` to localStorage; call `updateOpacityBadge()`; read `reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches`; call `L.setOpacity(level, { instant: reduced })`
    - Implement `cycleOpacity()`: `const i = OPACITY_LEVELS.indexOf(currentOpacity); const next = OPACITY_LEVELS[(i + 1) % OPACITY_LEVELS.length]; setOpacity(next);`
    - Implement `updateOpacityBadge()`: short-circuit on missing `opacityBadge` ref; set `opacityBadge.textContent = currentOpacity + '%'`
    - Do NOT add any DOM refs, click handlers, or boot calls in this task — that's task 6.1
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 4.1, 4.2, 4.3, 4.4, 15.6, 15.7, 16.1, 16.3_

- [x] 5. Renderer markup updates
  - [x] 5.1 Update `lumen/renderer/index.html` markup
    - Add `<span id="opacity-badge" class="badge nodrag" title="Window opacity">100%</span>` inside `<header class="title">` alongside `#eye` / `#ear` (Req 3.1, 3.3)
    - Add `<button class="ghost btn" id="opacity">100%</button>` in the bottom action row of `.cmd`, between `#listen` and `#clear` (Req 1.1, 8.1)
    - Wrap the body of `<details>` (everything between `<summary>Backend settings</summary>` and the closing `</details>`) in a single `<div class="settings-body">...</div>` so the JS-toggled height transition has a clean target (Req 7.5)
    - Move the `<div class="transcript-actions">` row in `#transcript-wrap` so it sits **above** `#transcript-text` (it currently sits below), and rename the class from `transcript-actions` to `transcript-toolbar` (Req 10.1, 10.2)
    - Add `class="btn"` (composing with each button's existing `.ghost` or `.primary` class) to all 11 buttons: `#listen`, `#share`, `#send`, `#clear`, `#savekey`, `#clearkey`, `#ping`, `#transcript-use`, `#transcript-append`, `#transcript-clear`, `#opacity` (Req 8.1)
    - Do NOT add CSS in this task — that's task 11.1
    - _Requirements: 1.1, 3.1, 3.3, 7.4, 7.5, 8.1, 10.1, 10.2_

- [x] 6. Renderer: wire the Opacity_Controller
  - [x] 6.1 Wire `Opacity_Controller` to DOM, boot, click, and hotkey in `lumen/renderer/renderer.js`
    - Add DOM refs at the top of the file alongside the other `$()` assignments: `const opacityBadge = $('opacity-badge');` and `const opacityBtn = $('opacity');`
    - On boot (added below the existing `L.onFocusInput(...)` / `L.onClickThroughChange(...)` block): call `currentOpacity = loadOpacity();`, then `updateOpacityBadge();`, then `L.setOpacity(currentOpacity, { instant: true });` (no animation on first paint, regardless of media query)
    - Wire button + hotkey to the same chokepoint: `opacityBtn.addEventListener('click', cycleOpacity);` and `L.onOpacityCycle(cycleOpacity);`
    - Verify by source-grep that the controller has zero listeners on `toggleScreen`, `setIgnoreMouseEvents`, `startWhisper`, `stopWhisper`, or `L.onClickThroughChange` (this is the structural guarantee for Req 5.1–5.4)
    - _Requirements: 1.1, 2.3, 3.1, 3.2, 3.3, 4.2, 5.1, 5.2, 5.3, 5.4, 6.1, 17.3_

- [x] 7. Renderer: settings panel collapse handler
  - [x] 7.1 Add the settings-panel collapse handler in `lumen/renderer/renderer.js`
    - Add `const SETTINGS_KEY = 'lumen.settings.expanded';`
    - Add DOM refs `const settingsDetails = document.querySelector('.cmd > details');` and `const settingsSummary = settingsDetails.querySelector('summary');`
    - Implement `loadSettingsExpanded()`: read `localStorage.getItem(SETTINGS_KEY)`; return `true` only on `'true'`, `false` only on `'false'`; otherwise overwrite storage with `'false'` and return `false`
    - Implement `applySettingsExpanded(expanded)`: `settingsDetails.classList.toggle('expanded', expanded)`; `settingsSummary.setAttribute('aria-expanded', expanded ? 'true' : 'false')`; write `expanded ? 'true' : 'false'` to localStorage
    - Wire the click handler: `settingsSummary.addEventListener('click', (e) => { e.preventDefault(); applySettingsExpanded(!settingsDetails.classList.contains('expanded')); });` — the `preventDefault` cancels the native `<details>` toggle so our class drives the animation
    - Initialize on boot: `applySettingsExpanded(loadSettingsExpanded());`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 11.2, 11.3_

- [x] 8. Renderer: typing indicator helper
  - [x] 8.1 Add `addAssistantPlaceholder()` and replace the `…` literal in `ask()` in `lumen/renderer/renderer.js`
    - Add helper `addAssistantPlaceholder()` that creates `<div class="msg assistant">` containing `<span class="typing"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></span>`, appends to `chat`, scrolls to bottom, and returns the outer div (matches the design's exact DOM shape)
    - In `ask()`, replace the existing `addMsg('assistant', '…')` call with `addAssistantPlaceholder()`
    - Do NOT modify `streamSSE`, `streamGemini`, or `streamOllama` — they already call `target.textContent = ''` on the first streamed token, which removes the `.typing` element synchronously (Req 13.3)
    - Verify by source-grep that `addMsg('assistant', '…')` no longer appears in `lumen/renderer/renderer.js`
    - _Requirements: 13.1, 13.2, 13.3_

- [x] 9. Renderer: `setStatus` shimmer extension
  - [x] 9.1 Extend `setStatus()` in `lumen/renderer/renderer.js` to toggle the shimmer class
    - Append a single line at the bottom of `setStatus(s, ok)`: `if (transcriptText) transcriptText.classList.toggle('shimmer', s === 'transcribing…');`
    - Do NOT touch `updateStatusLine()` — the existing flow (`inFlight > 0` → `setStatus('transcribing…', true)`) already drives the shimmer through this hook
    - Do NOT change the `setStatus` function signature or its existing two-line body
    - _Requirements: 14.1, 14.2, 14.3_

- [x] 10. Renderer: title attribute init helper
  - [x] 10.1 Add the title-attribute init helper in `lumen/renderer/renderer.js`
    - Run once at module init (after the boot wiring of task 6.1 / task 7.1 so all DOM refs exist)
    - Compute `const mod = L.platform === 'darwin' ? 'Cmd' : 'Ctrl';`
    - Set `sendBtn.title = 'Send (' + mod + '+Enter)'`
    - Set `opacityBtn.title = 'Cycle opacity (' + mod + '+Shift+O)'`
    - Set plain-English action text on the rest: `listenBtn.title = 'Toggle microphone listening (Whisper)'`, `shareBtn.title = 'Toggle screen sharing'`, `clearBtn.title = 'Clear chat history'`, `savekeyBtn.title = 'Save API key to local storage'`, `clearkeyBtn.title = 'Remove the saved API key'`, `pingBtn.title = 'Check connection to the selected backend'`, `transcriptUse.title = 'Replace the input with the current transcript'`, `transcriptAppend.title = 'Append the current transcript to the input'`, `transcriptClear.title = 'Clear the current transcript'`
    - Do NOT add any third-party tooltip library
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [x] 11. Renderer: CSS additions
  - [x] 11.1 Add new CSS rules to the `<style>` block in `lumen/renderer/index.html`
    - Add `.btn` shared-state rules: border-radius, `transition: background-color 200ms ease, border-color 200ms ease` for the hover transition (Req 8.4); active-state composition layered on `.active` (so `.btn.active` gets the existing red-tint treatment); disabled-state rule `.btn:disabled` with `opacity: 0.5`, `cursor: not-allowed`, and `.btn:disabled:hover { background: transparent; }` to suppress hover when disabled (Req 8.5)
    - Add `.transcript-toolbar` block: `display: flex; gap: 6px; align-items: center; padding: 4px 6px; background: rgba(255,255,255,0.02); border-bottom: 1px solid var(--border);` (Req 10.3)
    - Add `details .settings-body { overflow: hidden; max-height: 0; opacity: 0; transition: max-height 250ms ease, opacity 250ms ease; }` and `details.expanded .settings-body { max-height: 360px; opacity: 1; }` to drive the JS-toggled expand/collapse (Req 7.5)
    - Add `details summary` height rule clamping the collapsed header to ≤ 40 px (Req 11.3)
    - Add `.chat { gap: 10px; }` confirmation (already 10px in baseline; preserve ≥ 8 px) (Req 11.1)
    - Add `@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }` and apply via `.msg { animation: fadeIn 250ms ease-out; }` (Req 12.1, 12.2, 12.3)
    - Add `@keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }` and `.typing { display: inline-flex; gap: 4px; }`; `.typing-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: pulse 1s ease-in-out infinite; }`; stagger via `.typing-dot:nth-child(2) { animation-delay: 0.2s; } .typing-dot:nth-child(3) { animation-delay: 0.4s; }` (Req 13.2)
    - Add `@keyframes shimmer { 0% { background-position: -200px 0; } 100% { background-position: 200px 0; } }` and `#transcript-text.shimmer { background: linear-gradient(90deg, var(--bg) 0%, rgba(255,255,255,0.04) 50%, var(--bg) 100%); background-size: 400px 100%; animation: shimmer 1.5s linear infinite; }` (Req 14.1, 14.3)
    - Add `@media (prefers-reduced-motion: reduce) { .msg { animation: none !important; } .btn { transition: none !important; } details .settings-body { transition: none !important; } .typing, .typing-dot { animation: none !important; } #transcript-text.shimmer { animation: none !important; background: var(--bg); } }` (Req 15.1, 15.2, 15.3, 15.4, 15.5)
    - _Requirements: 7.5, 8.1, 8.2, 8.3, 8.4, 8.5, 10.3, 11.1, 11.2, 11.3, 12.1, 12.2, 12.3, 13.2, 14.1, 14.3, 15.1, 15.2, 15.3, 15.4, 15.5_

- [ ] 12. Property tests (using fast-check, already in `devDependencies`)
  - [ ]* 12.1 Write property test for cycle invariant in `lumen/tests/opacityPbt.test.js`
    - **Property 1: Opacity stays in the valid set under any cycle sequence**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 2.3**
    - Generate an array of length up to 100 of `'click' | 'hotkey'` cycle actions, plus an arbitrary initial opacity ∈ `{100, 70, 40}` seeded into the harness's `localStorage` shim
    - Drive each action through `harness.cycleOpacity()` (the same chokepoint covers both click and hotkey)
    - After every action assert `harness.getState().currentOpacity ∈ {100, 70, 40}` AND that the transition followed `100 → 70 → 40 → 100` from the previous value
    - Run ≥100 fast-check iterations

  - [ ]* 12.2 Write property test for persistence round-trip in `lumen/tests/opacityPbt.test.js`
    - **Property 2: Opacity persists across renderer reload**
    - **Validates: Requirements 4.1, 4.2**
    - Generate the same action stream as P1
    - Drive every action; capture `harness.getState().currentOpacity` after the last action; tear down and rebuild the harness against the **same** localStorage shim
    - Assert the new harness's `loadOpacity()` returns the captured value
    - Run ≥100 fast-check iterations

  - [ ]* 12.3 Write property test for corruption-safe `loadOpacity` in `lumen/tests/opacityPbt.test.js`
    - **Property 3: `loadOpacity()` is corruption-safe**
    - **Validates: Requirements 4.3, 4.4**
    - Generate `fc.oneof(fc.constant(undefined), fc.string())` and seed it into `localStorage['lumen.opacity']` (`undefined` means missing key)
    - Call `harness.loadOpacity()`
    - Assert: when the seed is exactly `'100'` / `'70'` / `'40'`, the return is the matching number AND localStorage is unchanged; otherwise the return is `100` AND localStorage has been overwritten with `'100'`
    - Run ≥100 fast-check iterations

  - [ ]* 12.4 Write property test for unrelated events not moving opacity in `lumen/tests/opacityPbt.test.js`
    - **Property 4: Unrelated state changes do not move opacity**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
    - Generate an array of length up to 100 of `'screen-share' | 'click-through' | 'whisper-start' | 'whisper-stop'` events (NO cycle actions); seed an arbitrary initial opacity
    - Drive every event through `harness.simulateUnrelatedEvent(name)` (which is a no-op stub — that's the structural point)
    - Assert `harness.getState().currentOpacity` and `localStorage['lumen.opacity']` both equal the initial value, AND that `harness.mocks.setOpacity.callCount === 0` for the duration of the run
    - Run ≥100 fast-check iterations

  - [ ]* 12.5 Write property test for settings panel persistence in `lumen/tests/opacityPbt.test.js`
    - **Property 5: Settings panel collapse persists**
    - **Validates: Requirements 7.1, 7.2**
    - Generate an array of length up to 100 of `'toggle'` actions plus an arbitrary initial expanded boolean
    - Drive every toggle through `harness.toggleSettings()`; after each toggle assert `localStorage['lumen.settings.expanded']` matches `harness.getState().settingsExpanded ? 'true' : 'false'`
    - Tear down and rebuild against the same storage; assert `harness.getState().settingsExpanded` matches the captured final value
    - Run ≥100 fast-check iterations

- [ ] 13. Unit tests
  - [ ]* 13.1 Hotkey collision unit test in `lumen/tests/uiPolishUnits.test.js`
    - Read `lumen/main.js` from disk; parse the `bindings` object literal text (e.g. via regex extracting every `'CommandOrControl+Shift+...'` key)
    - Assert `'CommandOrControl+Shift+O'` is present exactly once
    - Assert the set of bindings does not contain any duplicate key
    - Assert the set is disjoint with the legacy chord set written verbatim in the test (`Space`, `L`, `T`, `Up`, `Down`, `Left`, `Right`) — that is, `O` is not in the legacy set
    - _Requirements: 2.1, 2.2, 2.4_

  - [ ]* 13.2 Settings panel persistence on init in `lumen/tests/uiPolishUnits.test.js`
    - For each seed in `['true', 'false', null, 'yes', '', '1', 'TRUE']`: instantiate `createOpacityHarness({ localStorage: { 'lumen.settings.expanded': seed } })` (omit the key when seed is `null`)
    - Assert `harness.getState().settingsExpanded === true` only for seed `'true'`; `false` for every other input
    - Assert `harness.mocks.localStorage.getItem('lumen.settings.expanded')` equals `'true'` only when the harness ended in the expanded state, else `'false'` (i.e. corrupt seeds are overwritten with `'false'`)
    - _Requirements: 7.1, 7.2_

  - [ ]* 13.3 Button title attribute generation in `lumen/tests/uiPolishUnits.test.js`
    - Build a fake DOM (jsdom or a hand-rolled `{ id, title }` map) carrying all 11 button refs
    - For each platform in `['darwin', 'win32', 'linux']`: stub `L.platform`; run the title-init helper from task 10.1 (extract or re-implement the helper as a pure function exported for tests if needed)
    - Assert `sendBtn.title` contains `'Cmd+Enter'` when `platform === 'darwin'` and `'Ctrl+Enter'` otherwise (Req 9.1)
    - Assert `opacityBtn.title` contains `'Cmd+Shift+O'` when `platform === 'darwin'` and `'Ctrl+Shift+O'` otherwise (Req 9.2)
    - Assert each of `listenBtn`, `shareBtn`, `clearBtn`, `savekeyBtn`, `clearkeyBtn`, `pingBtn`, `transcriptUse`, `transcriptAppend`, `transcriptClear` has a non-empty `title` containing at least one alphabetic character (Req 9.3)
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [ ]* 13.4 Reduced-motion handling in `lumen/tests/uiPolishUnits.test.js`
    - Build the harness with `reducedMotion: true`, call `harness.setOpacity(70)`, assert the most recent `harness.mocks.setOpacity` call has args `[70, { instant: true }]` (Req 15.6)
    - Rebuild with `reducedMotion: false`, call `harness.setOpacity(70)`, assert the most recent `harness.mocks.setOpacity` call has args `[70, { instant: false }]` (Req 15.7 — state still changes)
    - In both cases assert `harness.getState().currentOpacity === 70` AND `harness.mocks.localStorage.getItem('lumen.opacity') === '70'` so the state change still takes effect under reduced motion
    - _Requirements: 15.6, 15.7_

  - [ ]* 13.5 `setStatus` shimmer toggle in `lumen/tests/uiPolishUnits.test.js`
    - Build a minimal DOM stub: a fake `transcriptText` element with a real `classList` (use a tiny `class FakeClassList` or `document.createElement('div')` if jsdom is available) and a fake `statusEl`
    - Re-create the `setStatus` function under test (or extract it as a pure helper exported for tests)
    - Call `setStatus('transcribing…', true)`, assert `transcriptText.classList.contains('shimmer') === true` (Req 14.1)
    - Call `setStatus('listening…', true)`, assert `transcriptText.classList.contains('shimmer') === false` (Req 14.2)
    - Call `setStatus('listening stopped', false)`, assert `false` again
    - _Requirements: 14.1, 14.2_

  - [ ]* 13.6 Typing indicator removal in `lumen/tests/uiPolishUnits.test.js`
    - Build a jsdom-style DOM with a `chat` container; call `addAssistantPlaceholder()`; assert the returned bubble contains a `.typing` element with three `.typing-dot` children (Req 13.1, 13.2)
    - Simulate the first streamed token by setting `bubble.textContent = ''` (matches the existing `streamSSE` / `streamGemini` / `streamOllama` behavior); within the next microtask assert `bubble.querySelector('.typing') === null` (Req 13.3 — happens synchronously, well under 100 ms)
    - _Requirements: 13.1, 13.2, 13.3_

  - [ ]* 13.7 `loadOpacity` overwrite-on-corrupt in `lumen/tests/uiPolishUnits.test.js`
    - Seed the harness localStorage with `'lumen.opacity': '50'` (numeric but out-of-set) and assert `harness.loadOpacity()` returns `100` AND `harness.mocks.localStorage.getItem('lumen.opacity') === '100'` afterwards (Req 4.4 explicit overwrite)
    - Seed with `''` (empty string) and assert the same
    - Seed with `'  100  '` (whitespace) and assert the same (the validator accepts only the exact strings — whitespace is rejected)
    - Seed with no key at all and assert the value `100` is returned AND `'lumen.opacity'` is now present with value `'100'` (Req 4.3)
    - Seed with `'100'` exactly and assert no overwrite happens
    - _Requirements: 4.3, 4.4_

- [x] 14. Manual testing checklist
  - [x] 14.1 Create `lumen/UI-POLISH-TESTING.md`
    - Mirror the existing `lumen/MIC-FIX-TESTING.md` and `lumen/WHISPER-MIC-TESTING.md` markdown style
    - Transcribe the 10-step checklist verbatim from `design.md`'s "Manual end-to-end checklist" section: app launch + collapsed Settings_Panel; opacity button cycles 100% → 70% → 40% → 100% with badge update within 100 ms; hotkey cycles the same; OS-level reduce-motion suppresses tween + collapse animation but state still changes; restart preserves last opacity AND last expanded state; screen-share / click-through / Whisper toggles do NOT move opacity; typing pulse + chat fade-in + transcribing shimmer all observable; hover transition consistent across all 11 buttons; native tooltip surfaces within ~1 second; OS screenshot at 70% confirms content-protection still excludes Lumen
    - Add a header note that this is a manual-only checklist that complements `npm test` (which covers the automated property + unit tests)
    - _Requirements: 1.1, 2.1, 2.2, 3.2, 4.2, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 7.1, 7.2, 7.5, 8.4, 9.1, 9.2, 9.3, 12.1, 12.2, 13.1, 13.2, 14.1, 15.1, 15.2, 15.6, 17.1_

- [x] 15. Final checkpoint - Full test sweep
  - Run `npm test` and confirm all property tests (12.1–12.5) and all unit tests (13.1–13.7) pass
  - Manually confirm `npm start` launches without runtime errors
  - Walk through the 10-step manual checklist in `lumen/UI-POLISH-TESTING.md`
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Sub-tasks marked with `*` are optional test tasks and can be skipped for a faster MVP; core implementation tasks (no `*`) must be implemented.
- Each task references the granular sub-requirement clauses it covers in `requirements.md` rather than only the parent user story.
- Property test sub-tasks (12.1–12.5) drive the harness from task 1.1 directly so they do not need any of the renderer wiring tasks (4.1, 6.1, 7.1) to be complete — they validate the controller's logic via the harness mirror.
- Unit test sub-tasks (13.1–13.7) cross-reference real source files (e.g. 13.1 reads `lumen/main.js` from disk) and rebuild the harness with different seeds; they are scheduled after the implementation waves so the source-grep checks see the final code.
- The dependency graph below serializes every write to `lumen/renderer/renderer.js`, `lumen/renderer/index.html`, `lumen/main.js`, `lumen/tests/opacityPbt.test.js`, and `lumen/tests/uiPolishUnits.test.js` because tasks that share a file cannot run in the same wave without conflicts.
- Checkpoint task 15 and top-level parent tasks (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14) are not included in the dependency graph — only leaf sub-tasks are scheduled.
- Out of scope (explicitly excluded by `requirements.md` and `design.md`, not present in this plan): theme switcher, resizable panels, layout restructure, screenshot region select, multi-monitor handling, auto-triggered opacity changes from screen-share or click-through.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "4.1", "5.1", "14.1"] },
    { "id": 1, "tasks": ["2.2", "6.1", "11.1"] },
    { "id": 2, "tasks": ["7.1"] },
    { "id": 3, "tasks": ["8.1"] },
    { "id": 4, "tasks": ["9.1"] },
    { "id": 5, "tasks": ["10.1"] },
    { "id": 6, "tasks": ["12.1", "13.1"] },
    { "id": 7, "tasks": ["12.2", "13.2"] },
    { "id": 8, "tasks": ["12.3", "13.3"] },
    { "id": 9, "tasks": ["12.4", "13.4"] },
    { "id": 10, "tasks": ["12.5", "13.5"] },
    { "id": 11, "tasks": ["13.6"] },
    { "id": 12, "tasks": ["13.7"] }
  ]
}
```
