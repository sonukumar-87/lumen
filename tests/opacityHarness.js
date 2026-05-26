// Test harness for the Opacity_Controller + Settings_Panel collapse logic
// described in .kiro/specs/ui-polish-and-see-through/design.md.
//
// The harness reimplements the renderer's Opacity_Controller and the
// settings-panel persistence helpers as plain JS so property and example
// tests can drive them deterministically — without spinning up Electron,
// jsdom, or real DOM. It is *self-contained* and does NOT import from
// renderer/renderer.js (the renderer's Opacity_Controller is created by
// later tasks; this harness encodes what the design says it should do).
//
// Mocks:
//   - localStorage (Map-backed shim, mirrors whisperHarness.js)
//   - L.setOpacity(level, opts)         — spy
//   - window.matchMedia(query)          — configurable `{ matches }`
//
// Public API: createOpacityHarness(opts) → harness object exposing
// cycleOpacity, setOpacity, loadOpacity, toggleSettings,
// simulateUnrelatedEvent, getState, plus getters mirroring
// `currentOpacity` and `settingsExpanded`. Mirrors the patterns in
// whisperHarness.js (CommonJS, single factory export, `mocks` namespace
// for direct spy access).

'use strict';

// ── Small utilities ─────────────────────────────────────────────────────────

function makeSpy() {
  const fn = function (...args) {
    fn.calls.push(args);
    fn.callCount += 1;
    if (fn._impl) return fn._impl.apply(this, args);
    return undefined;
  };
  fn.calls = [];
  fn.callCount = 0;
  fn._impl = null;
  return fn;
}

// Map-backed localStorage shim. Mirrors whisperHarness.js so tests written
// against either harness see the same surface.
function makeLocalStorage(initial) {
  const store = new Map();
  if (initial && typeof initial === 'object') {
    for (const k of Object.keys(initial)) store.set(k, String(initial[k]));
  }
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
    key(i) { return Array.from(store.keys())[i] ?? null; },
    get length() { return store.size; },
  };
}


// ── Constants (mirror renderer.js Opacity_Controller and settings handler) ──

const OPACITY_LEVELS = [100, 70, 40];        // valid set; cycle order
const OPACITY_KEY = 'lumen.opacity';
const SETTINGS_KEY = 'lumen.settings.expanded';


// ── Harness entry point ─────────────────────────────────────────────────────

/**
 * Build an Opacity_Controller test harness.
 *
 * @param {object} [opts]
 * @param {object} [opts.localStorage] — initial localStorage entries
 *        (e.g. { 'lumen.opacity': '70', 'lumen.settings.expanded': 'true' })
 * @param {boolean} [opts.reducedMotion=false] — initial value the
 *        `window.matchMedia('(prefers-reduced-motion: reduce)')` mock
 *        reports via `.matches`. Tests can flip it mid-run via
 *        `harness.mocks.matchMedia.setReducedMotion(bool)`.
 * @param {string} [opts.platform='darwin'] — value of L.platform (kept
 *        for parity with whisperHarness; currently unused by the
 *        controller itself but useful for downstream unit tests).
 * @returns {object} harness
 */
function createOpacityHarness(opts) {
  const cfg = opts || {};

  // ── Mocks ──

  // localStorage shim
  const localStorageMock = makeLocalStorage(cfg.localStorage);

  // matchMedia mock — the controller calls
  // window.matchMedia('(prefers-reduced-motion: reduce)').matches at the
  // moment of every cycle. We back it with a mutable flag so tests can
  // flip reduced-motion on/off without rebuilding the harness.
  let reducedMotion = !!cfg.reducedMotion;
  const matchMediaSpy = function (query) {
    matchMediaSpy.calls.push([query]);
    matchMediaSpy.callCount += 1;
    return { matches: reducedMotion, media: String(query) };
  };
  matchMediaSpy.calls = [];
  matchMediaSpy.callCount = 0;
  matchMediaSpy.setReducedMotion = function (next) { reducedMotion = !!next; };

  // L.setOpacity — the wire mock that the renderer would hand off to
  // ipcRenderer.send('lumen:set-opacity', { level, instant }). Captured
  // here as a spy so tests can assert the wire payload (especially
  // `{ instant }`).
  const setOpacitySpy = makeSpy();

  // Convenience handle on the most-recent setOpacity call.
  function lastSetOpacityCall() {
    if (setOpacitySpy.calls.length === 0) return null;
    return setOpacitySpy.calls[setOpacitySpy.calls.length - 1];
  }


  // ── Opacity_Controller state (mirrors renderer.js design) ──

  let currentOpacity = 100;
  let opacityBadgeText = '100%';

  function loadOpacity() {
    const raw = localStorageMock.getItem(OPACITY_KEY);
    if (raw === '100' || raw === '70' || raw === '40') return Number(raw);
    // Missing or malformed → 100 and overwrite (Req 4.3, 4.4).
    localStorageMock.setItem(OPACITY_KEY, '100');
    return 100;
  }

  function updateOpacityBadge() {
    opacityBadgeText = currentOpacity + '%';
  }

  function setOpacity(level) {
    if (!OPACITY_LEVELS.includes(level)) return;  // defensive; no-op on bad input
    currentOpacity = level;
    localStorageMock.setItem(OPACITY_KEY, String(level));
    updateOpacityBadge();
    const reduced = matchMediaSpy('(prefers-reduced-motion: reduce)').matches;
    setOpacitySpy(level, { instant: reduced });
  }

  function cycleOpacity() {
    const i = OPACITY_LEVELS.indexOf(currentOpacity);
    const next = OPACITY_LEVELS[(i + 1) % OPACITY_LEVELS.length];   // 100→70→40→100
    setOpacity(next);
  }


  // ── Settings_Panel persistence (mirrors renderer.js design) ──

  let settingsExpanded = false;

  function loadSettingsExpanded() {
    const raw = localStorageMock.getItem(SETTINGS_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    // Missing or malformed → collapsed and overwrite (Req 7.1).
    localStorageMock.setItem(SETTINGS_KEY, 'false');
    return false;
  }

  function applySettingsExpanded(expanded) {
    settingsExpanded = !!expanded;
    localStorageMock.setItem(SETTINGS_KEY, settingsExpanded ? 'true' : 'false');
  }

  function toggleSettings() {
    applySettingsExpanded(!settingsExpanded);
  }


  // ── Init: load from localStorage and set initial state ──

  currentOpacity = loadOpacity();
  updateOpacityBadge();
  applySettingsExpanded(loadSettingsExpanded());


  // ── Test-facing helpers ──

  // No-op stub used by Property 4 (unrelated state changes do not move
  // opacity). The structural point is that the controller has *no
  // listeners* on screen-share / click-through / whisper start/stop;
  // calling this should never touch opacity. It simply records the call
  // for assertion.
  const unrelatedEventCalls = [];
  function simulateUnrelatedEvent(name) {
    unrelatedEventCalls.push(String(name));
    // Intentionally a no-op: the renderer's Opacity_Controller registers
    // zero listeners on these events. Verified structurally in task 6.1.
  }

  // Inspect the harness state. Useful for property tests that want a single
  // snapshot to assert against.
  function getState() {
    return {
      currentOpacity,
      settingsExpanded,
      opacityBadgeText,
      lastSetOpacityCall: lastSetOpacityCall(),
      setOpacityCalls: setOpacitySpy.callCount,
      unrelatedEventCalls: unrelatedEventCalls.slice(),
      mocks: {
        setOpacity: setOpacitySpy,
        localStorage: localStorageMock,
        matchMedia: matchMediaSpy,
      },
    };
  }

  // ── The harness object the tests interact with ──
  const harness = {
    // Drive the controller
    cycleOpacity,
    setOpacity,
    loadOpacity,
    toggleSettings,
    simulateUnrelatedEvent,

    // Inspect everything
    getState,

    // Convenience getters (mirror the whisperHarness pattern)
    get currentOpacity() { return currentOpacity; },
    get settingsExpanded() { return settingsExpanded; },
    get opacityBadgeText() { return opacityBadgeText; },
    get setOpacityCalls() { return setOpacitySpy.callCount; },
    get lastSetOpacityCall() { return lastSetOpacityCall(); },

    // Direct access to the mocks for advanced assertions
    mocks: {
      setOpacity: setOpacitySpy,
      localStorage: localStorageMock,
      matchMedia: matchMediaSpy,
    },

    // Configuration knobs the tests can flip mid-test
    setReducedMotion(next) { reducedMotion = !!next; },
  };

  return harness;
}

module.exports = {
  createOpacityHarness,
  // exported for unit tests that want the constants directly
  OPACITY_LEVELS,
  OPACITY_KEY,
  SETTINGS_KEY,
};
