// Tests for the two-channel capture path (You = microphone, Them = system
// audio loopback).
//
// renderer.js is a browser script with DOM and Electron dependencies, so it
// cannot be imported directly — the same reason tests 10.5 and 10.7 read it as
// source. Where a function is self-contained, this file extracts it from the
// source and executes the real implementation rather than a reimplementation.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RENDERER_PATH = resolve(__dirname, '../renderer/renderer.js');
const MAIN_PATH = resolve(__dirname, '../main.js');
const PKG_PATH = resolve(__dirname, '../package.json');

const rendererSrc = readFileSync(RENDERER_PATH, 'utf8');
const mainSrc = readFileSync(MAIN_PATH, 'utf8');

// Pull a top-level `function name(...) { ... }` out of the source by matching
// braces, so the real implementation can be executed in isolation.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in source`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

// Build a sandbox holding the real createCaptureChannel + appendTranscriptEntry
// over fresh module-scope state.
function loadTranscriptSandbox() {
  const body = `
    let transcriptEntries = [];
    let finalTranscript = '';
    ${extractFunction(rendererSrc, 'createCaptureChannel')}
    ${extractFunction(rendererSrc, 'appendTranscriptEntry')}
    return {
      createCaptureChannel,
      appendTranscriptEntry,
      getEntries: () => transcriptEntries,
      getFinal: () => finalTranscript,
    };
  `;
  return new Function(body)();
}

describe('capture channels — independent per-channel state', () => {
  it('gives each channel its own recorder, sequence, and ordering queue', () => {
    const { createCaptureChannel } = loadTranscriptSandbox();
    const a = createCaptureChannel('you', 'You');
    const b = createCaptureChannel('them', 'Them');

    // Sharing any of these between channels would interleave the two audio
    // streams and scramble both transcripts.
    expect(a.pending).not.toBe(b.pending);
    a.chunkSeq = 7;
    expect(b.chunkSeq).toBe(0);
    a.pending.set(0, { ok: true, text: 'mine' });
    expect(b.pending.size).toBe(0);
    a.inFlight = 3;
    expect(b.inFlight).toBe(0);
  });

  it('starts inactive with a zeroed silence meter', () => {
    const { createCaptureChannel } = loadTranscriptSandbox();
    const ch = createCaptureChannel('them', 'Them');
    expect(ch.active).toBe(false);
    expect(ch.peakRMS).toBe(0);
    expect(ch.stream).toBe(null);
    expect(ch.recorder).toBe(null);
  });
});

describe('transcript attribution', () => {
  it('tags each utterance with the channel that produced it', () => {
    const s = loadTranscriptSandbox();
    const you = s.createCaptureChannel('you', 'You');
    const them = s.createCaptureChannel('them', 'Them');

    s.appendTranscriptEntry(them, 'What is your experience with React?');
    s.appendTranscriptEntry(you, 'About three years.');

    const entries = s.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ channel: 'them', label: 'Them' });
    expect(entries[1]).toMatchObject({ channel: 'you', label: 'You' });
  });

  it('merges consecutive utterances from the same speaker into one turn', () => {
    const s = loadTranscriptSandbox();
    const them = s.createCaptureChannel('them', 'Them');

    // Chunk rotation splits continuous speech across several posts; they
    // should read as one turn, not three rows.
    s.appendTranscriptEntry(them, 'So tell me');
    s.appendTranscriptEntry(them, 'about a time');
    s.appendTranscriptEntry(them, 'you disagreed.');

    const entries = s.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('So tell me about a time you disagreed.');
  });

  it('starts a new turn when the speaker changes back', () => {
    const s = loadTranscriptSandbox();
    const you = s.createCaptureChannel('you', 'You');
    const them = s.createCaptureChannel('them', 'Them');

    s.appendTranscriptEntry(them, 'Question one.');
    s.appendTranscriptEntry(you, 'My answer.');
    s.appendTranscriptEntry(them, 'Question two.');

    expect(s.getEntries().map(e => e.channel)).toEqual(['them', 'you', 'them']);
  });

  it('keeps finalTranscript as the plain concatenation for Use/Append/Clear', () => {
    const s = loadTranscriptSandbox();
    const you = s.createCaptureChannel('you', 'You');
    const them = s.createCaptureChannel('them', 'Them');

    s.appendTranscriptEntry(them, 'Hello.');
    s.appendTranscriptEntry(you, 'Hi.');

    // The existing controls read this string; speaker labels live only in the
    // rendered view, so those handlers keep behaving exactly as before.
    expect(s.getFinal()).toBe('Hello. Hi.');
  });
});

describe('renderer wiring for system audio', () => {
  it('requests loopback audio on the Them channel', () => {
    expect(rendererSrc).toMatch(/getDisplayMedia\(\{\s*video:\s*true,\s*audio:\s*true\s*\}\)/);
  });

  it('records an audio-only view without stopping the capture video track', () => {
    // Stopping the video track ends the capture session on macOS and the
    // loopback audio dies with it — the recorder then yields empty blobs
    // forever and the channel is silently mute. Recording must run off a
    // separate MediaStream built from the audio tracks instead.
    const body = extractFunction(rendererSrc, 'startSystemChannel');
    expect(body).toMatch(/new MediaStream\(audioTracks\)/);
    expect(body).not.toMatch(/getVideoTracks\(\)[\s\S]*?\.stop\(\)/);
  });

  it('keeps a handle on the capture stream so teardown can stop it', () => {
    expect(extractFunction(rendererSrc, 'startSystemChannel'))
      .toMatch(/captureStream\s*=\s*stream/);
    expect(extractFunction(rendererSrc, 'stopChannel'))
      .toMatch(/captureStream/);
  });

  it('keeps the mic on getUserMedia, independent of the loopback stream', () => {
    expect(rendererSrc).toMatch(/getUserMedia\(\{[\s\S]{0,200}?audio:/);
  });

  it('treats a failed system channel as non-fatal so the mic still runs', () => {
    // startSystemChannel returns false rather than throwing; startWhisper only
    // aborts when the microphone itself fails.
    const body = extractFunction(rendererSrc, 'startWhisper');
    expect(body).toMatch(/if\s*\(!micOk\)/);
    expect(body).not.toMatch(/if\s*\(!sysOk\)/);
    // A mic failure must not strand a live loopback capture.
    expect(body).toMatch(/if\s*\(sysOk\)\s*stopChannel\(sysChannel\)/);
  });

  it('opens the loopback before the mic, while the user gesture is still fresh', () => {
    // getDisplayMedia requires an active user gesture. Awaiting getUserMedia
    // first spends it, after which loopback capture is rejected — so the
    // ordering here is load-bearing, not stylistic.
    const body = extractFunction(rendererSrc, 'startWhisper');
    expect(body.indexOf('startSystemChannel()'))
      .toBeLessThan(body.indexOf('startMicChannel()'));
  });

  it('screen share still requests audio: false so that path is unchanged', () => {
    expect(rendererSrc).toMatch(/getDisplayMedia\(\{\s*video:\s*\{\s*frameRate:\s*10\s*\},\s*audio:\s*false\s*\}\)/);
  });
});

describe('silence gate', () => {
  it('fails open when the meter never produced a reading', () => {
    // peakRMS stuck at 0 with meterOk false means the meter is broken, not
    // that the room is quiet. Gating on it would discard every chunk for the
    // whole session — silent, total data loss.
    const body = extractFunction(rendererSrc, 'enqueueChunk');
    expect(body).toMatch(/ch\.meterOk\s*&&\s*peak\s*<\s*threshold/);
  });

  it('only trusts the meter once a non-zero sample is seen', () => {
    expect(extractFunction(rendererSrc, 'attachSilenceMeter'))
      .toMatch(/if\s*\(rms\s*>\s*0\)\s*ch\.meterOk\s*=\s*true/);
  });

  it('resumes a suspended AudioContext', () => {
    // A suspended context's analyser returns silence forever.
    expect(extractFunction(rendererSrc, 'attachSilenceMeter'))
      .toMatch(/state\s*===\s*'suspended'[\s\S]{0,120}resume\(\)/);
  });

  it('gives the loopback channel a lower floor than the mic', () => {
    // Mic audio runs through AGC; loopback does not, so it sits much lower.
    const body = extractFunction(rendererSrc, 'channelSilenceFloor');
    expect(body).toMatch(/'them'/);
    const sandbox = new Function(`
      let base = 0.018;
      function readSilenceThreshold() { return base }
      ${extractFunction(rendererSrc, 'channelSilenceFloor')}
      return channelSilenceFloor;
    `)();
    expect(sandbox({ name: 'them' })).toBeLessThan(sandbox({ name: 'you' }));
  });
});

describe('main process enablement', () => {
  it('enables the Chromium features macOS loopback needs, before app ready', () => {
    expect(mainSrc).toMatch(/MacLoopbackAudioForScreenShare/);
    expect(mainSrc).toMatch(/MacSckSystemAudioLoopbackOverride/);
    // Must precede createWindow — appendSwitch after app.ready is ignored.
    expect(mainSrc.indexOf('MacLoopbackAudioForScreenShare'))
      .toBeLessThan(mainSrc.indexOf('function createWindow'));
  });

  it("grants loopback audio as the literal 'loopback' string on darwin", () => {
    expect(mainSrc).toMatch(/grant\.audio\s*=\s*'loopback'/);
  });

  it('declares NSAudioCaptureUsageDescription for packaged builds', () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
    const info = pkg.build.mac.extendInfo;
    expect(info.NSAudioCaptureUsageDescription).toBeTruthy();
    // The mic string must survive too — both permissions are needed.
    expect(info.NSMicrophoneUsageDescription).toBeTruthy();
  });
});
