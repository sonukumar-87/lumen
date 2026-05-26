// Property-based tests for the Whisper_Client described in
// .kiro/specs/whisper-mic-transcription/design.md.
//
// Validates: Requirements 6.3, 6.4 (readChunkSeconds is a sound validator).
//
// The harness is a CommonJS module; vitest handles ESM ↔ CJS interop so the
// named import works against `module.exports = { createWhisperHarness, ... }`.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createWhisperHarness } from './whisperHarness.js';

describe('Property 4 — readChunkSeconds is a sound validator', () => {
  // **Validates: Requirements 6.3, 6.4**
  it('returns the parsed integer in [1,30] or default 5 for any string|null input', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: null }),
        (raw) => {
          const harness = createWhisperHarness({
            localStorage: raw == null ? {} : { 'lumen.whisper.chunkSeconds': raw },
          });
          const result = harness.readChunkSeconds();

          // Expected behavior per design.md / requirements 6.3, 6.4:
          //   absent / empty / non-finite / non-integer / outside [1,30] → 5
          //   otherwise → the parsed integer.
          const n = raw == null || raw === '' ? NaN : Number(raw);
          const isValidInt =
            Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 30;
          const expected = isValidInt ? n : 5;

          expect(result).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('handles the concrete edge cases called out in the spec', () => {
    const cases = [
      { input: '', expected: 5 },
      { input: '0', expected: 5 },
      { input: '0.5', expected: 5 },
      { input: '31', expected: 5 },
      { input: '-1', expected: 5 },
      { input: 'abc', expected: 5 },
      { input: '1', expected: 1 },
      { input: '5', expected: 5 },
      { input: '30', expected: 30 },
      { input: '  10  ', expected: 10 }, // Number('  10  ') === 10
      { input: '1e2', expected: 5 },     // Number('1e2') === 100, out of range
      { input: '1.0', expected: 1 },     // Number('1.0') === 1, an integer
    ];
    for (const { input, expected } of cases) {
      const harness = createWhisperHarness({
        localStorage: { 'lumen.whisper.chunkSeconds': input },
      });
      expect(harness.readChunkSeconds()).toBe(expected);
    }
  });

  it('returns 5 when the key is absent from localStorage', () => {
    const harness = createWhisperHarness({ localStorage: {} });
    expect(harness.readChunkSeconds()).toBe(5);
  });
});

describe('Property 1 — transcripts appended in chunk-emission order', () => {
  // **Validates: Requirements 2.4, 2.5, 2.7, 5.4**
  it('finalTranscript equals the in-emission-order concatenation of trimmed non-empty texts, regardless of response order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }).chain((n) =>
          fc.tuple(
            fc.constant(n),
            fc.array(
              fc.oneof(
                fc.string({ minLength: 0, maxLength: 24 }),
                fc.constantFrom('', '   ', 'hello', 'world', '  spaced  ', 'foo bar'),
              ),
              { minLength: n, maxLength: n },
            ),
            // Random permutation of [0..n-1]
            fc.shuffledSubarray(
              Array.from({ length: n }, (_, i) => i),
              { minLength: n, maxLength: n },
            ),
          ),
        ),
        async ([n, texts, permutation]) => {
          const harness = createWhisperHarness({
            localStorage: { 'lumen.key.groq': 'gsk_test_key' },
          });

          await harness.toggleListen();

          // Emit n chunks via successive rotate ticks.
          for (let i = 0; i < n; i++) harness.tickChunkInterval();

          // Drain initial microtasks so all postChunk promises are scheduled.
          await Promise.resolve();

          // Resolve fetches in the generated permutation.
          for (const seq of permutation) {
            harness.resolveFetch(seq, { ok: true, status: 200, json: { text: texts[seq] } });
            // Drain promise chain microtasks so drainAppendQueue runs.
            await Promise.resolve();
            await Promise.resolve();
          }

          // Expected: in-emission-order concatenation of trimmed non-empty texts.
          const trimmed = texts.map(t => t.trim());
          const expected = trimmed.filter(t => t.length > 0).join(' ');
          expect(harness.transcriptText).toBe(expected);

          // renderTranscript called at least once per contributing chunk.
          const contributingCount = trimmed.filter(t => t.length > 0).length;
          const state = harness.getState();
          expect(state.renderTranscriptCalls).toBeGreaterThanOrEqual(contributingCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 2 — bounded-error funnel: exactly one error and clean stop', () => {
  // **Validates: Requirements 1.4, 3.1, 3.2, 3.3, 3.4, 3.5**
  it('any failure class triggers exactly one user-visible error and stops listening cleanly', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('missing-key', 'mic-denied', 'fetch-network-error', 'http-non-2xx', 'malformed-json'),
        fc.integer({ min: 0, max: 8 }),
        async (failureKind, priorChunks) => {
          // Build harness opts based on failure class.
          const opts = {
            localStorage: failureKind === 'missing-key' ? {} : { 'lumen.key.groq': 'gsk_test_key' },
          };
          if (failureKind === 'mic-denied') {
            opts.getUserMedia = { reject: new Error('NotAllowedError') };
          }
          const harness = createWhisperHarness(opts);

          await harness.toggleListen();

          // For non-start-time failures, emit prior chunks then trigger the failure.
          if (failureKind !== 'missing-key' && failureKind !== 'mic-denied') {
            // Emit priorChunks + 1 chunks; the LAST one will be the failure.
            for (let i = 0; i < priorChunks + 1; i++) {
              harness.tickChunkInterval();
            }
            await Promise.resolve();

            // Resolve prior chunks successfully.
            for (let i = 0; i < priorChunks; i++) {
              harness.resolveFetch(i, { ok: true, status: 200, json: { text: 'ok' + i } });
              await Promise.resolve();
              await Promise.resolve();
            }

            // Trigger the failure on the last chunk (seq = priorChunks).
            const failSeq = priorChunks;
            switch (failureKind) {
              case 'fetch-network-error':
                harness.rejectFetch(failSeq, new Error('network'));
                break;
              case 'http-non-2xx':
                harness.resolveFetch(failSeq, { ok: false, status: 500, body: 'server error' });
                break;
              case 'malformed-json':
                harness.resolveFetch(failSeq, { ok: true, status: 200, json: { not_text: 'oops' } });
                break;
            }
            // Drain the failure's promise chain.
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
          }

          const fetchCallsBeforeAssertions = harness.fetchCalls.length;

          // Assertions
          const state = harness.getState();
          expect(state.errored).toBe(true);
          expect(state.listening).toBe(false);
          expect(state.lastTranscriptError).toBeTruthy(); // exactly-one — set
          expect(state.showTranscriptErrorCalls).toBe(1); // exactly-one
          expect(state.updateListenUICalls).toBeGreaterThanOrEqual(1);
          expect(state.chunkRotateTimer).toBeNull();

          // For mic-denied (start-time) and missing-key, no recorder/tracks ever existed.
          // For runtime failures, recorder.stop and track.stop must have been called.
          if (failureKind !== 'missing-key' && failureKind !== 'mic-denied') {
            // At least one recorder was constructed; its stop was called via stopWhisper.
            expect(state.recorderStopCalls).toBeGreaterThanOrEqual(1);
            // Tracks of the active stream were stopped.
            expect(state.trackStopCalls).toBeGreaterThanOrEqual(1);
          }

          // No new fetch calls after the failure-induced stop completes.
          // Tick the interval a few times — must NOT issue fetches because tickChunkInterval no-ops when !listening || errored.
          harness.tickChunkInterval();
          harness.tickChunkInterval();
          await Promise.resolve();
          expect(harness.fetchCalls.length).toBe(fetchCallsBeforeAssertions);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 3 — status-line reflects in-flight count under listening', () => {
  // **Validates: Requirements 4.1, 4.2, 4.3**
  it('after every event, lastStatus matches inFlight while listening with no error', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('start', 'end'), { minLength: 1, maxLength: 16 }),
        async (events) => {
          const harness = createWhisperHarness({
            localStorage: { 'lumen.key.groq': 'gsk_test_key' },
          });

          await harness.toggleListen();
          await Promise.resolve();

          const inFlightSeqs = [];
          let nextSeq = 0;

          for (const ev of events) {
            if (ev === 'start') {
              harness.tickChunkInterval();
              inFlightSeqs.push(nextSeq++);
              await Promise.resolve();
            } else if (ev === 'end') {
              if (inFlightSeqs.length === 0) continue; // preserve inFlight >= 0
              const seq = inFlightSeqs.shift();
              harness.resolveFetch(seq, { ok: true, status: 200, json: { text: 'x' } });
              // Drain promise chain.
              await Promise.resolve();
              await Promise.resolve();
            }

            // After every event: while listening && !errored, status must reflect inFlight.
            const state = harness.getState();
            if (state.listening && !state.errored) {
              const [text, ok] = state.lastStatus || [];
              if (state.inFlight > 0) {
                expect(text).toBe('transcribing…');
                expect(ok).toBe(true);
              } else {
                expect(text).toBe('listening…');
                expect(ok).toBe(true);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
