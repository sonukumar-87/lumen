# Requirements Document

## Introduction

Replace the in-overlay Web Speech API mic transcription with an OpenAI-compatible Whisper transcription path that posts microphone audio to Groq's `/v1/audio/transcriptions` endpoint using the `whisper-large-v3` model. Web Speech in Electron routes through a Google-internal endpoint that requires an API key the Electron build does not ship; even after the previous bugfix (`mic-transcription-broken`) bounded the auto-restart loop and surfaced a user-visible error, the underlying upload continues to fail and no transcripts are produced. This feature removes the dependency on Google's speech endpoint, restores working mic transcription, and keeps the existing privacy posture: BYOK, keys live in `localStorage` inside the app's `userData`, and only the user-chosen backend is contacted.

The mic UI surface is unchanged. The `🎤 Listen` button, the `#transcript-text` panel, the `Use as prompt` / `Append to prompt` / `Clear` actions, and the macOS mic-permission deep-link all behave the same to the user. Underneath, audio is captured via `MediaRecorder`, sliced into fixed-duration chunks, posted to the Whisper endpoint, and the returned text is appended to the transcript panel as each chunk completes.

Scope is tight: replace Web Speech with Groq Whisper, preserve the mic UI surface and permission flow, surface clear errors when transcription fails, and remove the Web Speech-specific restart-policy state introduced by the previous bugfix. Local Whisper (whisper.cpp), system-audio transcription, and other roadmap items are out of scope.

## Glossary

- **Renderer**: The `lumen/renderer/renderer.js` script that hosts mic UI, screen capture, and chat backends.
- **Whisper_Client**: New code path inside the Renderer that owns audio capture, chunked POSTing to the Whisper_Endpoint, and transcript assembly.
- **Whisper_Endpoint**: HTTPS endpoint the Whisper_Client posts audio chunks to. Default `https://api.groq.com/openai/v1/audio/transcriptions`.
- **Whisper_Model**: Identifier sent in the multipart form's `model` field. Default `whisper-large-v3`.
- **Audio_Chunk**: A `MediaRecorder` blob covering a single `Chunk_Duration_Seconds` window of microphone audio, encoded as `audio/webm;codecs=opus` when supported.
- **Chunk_Duration_Seconds**: Wall-clock length of each Audio_Chunk in seconds. Default 5. Valid range is the inclusive integer interval [1, 30].
- **Groq_API_Key**: The user's Groq API key, stored in `localStorage` under `lumen.key.groq` (the same key the Groq chat backend already uses).
- **Transcript_Panel**: The `#transcript-text` element in `renderer/index.html` that already renders mic transcripts.
- **`showTranscriptError(message)`**: Helper added by the previous bugfix; renders a single user-visible error message inside the Transcript_Panel using the existing `.err` style.
- **`renderTranscript()`**: Helper that re-renders the Transcript_Panel from the accumulated final and interim transcript strings.
- **`updateListenUI()`**: Helper that syncs the `🎤 Listen` button label, `🎤` badge, and Transcript_Panel visibility to the current listening state.
- **`L.openMicPerms()`**: Existing preload-bridge call that deep-links to the macOS Microphone privacy pane.

## Requirements

### Requirement 1: Capture microphone audio with MediaRecorder

**User Story:** As a Lumen user, I want my voice captured locally as opus audio chunks, so that audio can be sent to Groq Whisper without depending on Google's speech endpoint.

#### Acceptance Criteria

1. WHEN the user clicks the `🎤 Listen` button to start listening, THE Whisper_Client SHALL request microphone access via `navigator.mediaDevices.getUserMedia({ audio: true })`.
2. WHEN microphone access is granted, THE Whisper_Client SHALL start a `MediaRecorder` against the captured audio stream using `audio/webm;codecs=opus` when `MediaRecorder.isTypeSupported('audio/webm;codecs=opus')` returns `true`.
3. IF `MediaRecorder.isTypeSupported('audio/webm;codecs=opus')` returns `false`, THEN THE Whisper_Client SHALL start the `MediaRecorder` with the user agent's default mime type AND SHALL use the recorder's reported `mimeType` as the multipart `Content-Type` of each posted Audio_Chunk.
4. WHEN the user clicks the `🎤 Listen` button to stop listening, THE Whisper_Client SHALL stop the active `MediaRecorder` and SHALL stop every `MediaStreamTrack` of the captured audio stream.
5. IF microphone access is denied, THEN THE Whisper_Client SHALL render a user-visible error in the Transcript_Panel via `showTranscriptError`.
6. WHERE the host platform is `darwin`, IF microphone access is denied, THEN THE Whisper_Client SHALL invoke `L.openMicPerms()` to deep-link the macOS Microphone privacy pane.

### Requirement 2: Chunk audio at a fixed cadence and post each chunk to Whisper

**User Story:** As a Lumen user, I want transcribed text to appear continuously while I speak, so that I do not have to wait until I stop speaking to see the result.

#### Acceptance Criteria

1. WHILE listening is active, THE Whisper_Client SHALL emit a new Audio_Chunk every `Chunk_Duration_Seconds` of captured audio.
2. WHEN an Audio_Chunk is emitted, THE Whisper_Client SHALL POST the chunk to the Whisper_Endpoint as a `multipart/form-data` body containing fields `file` (the audio blob), `model` (Whisper_Model), and `response_format` set to `json`.
3. THE Whisper_Client SHALL include an `Authorization: Bearer <Groq_API_Key>` header on every POST to the Whisper_Endpoint.
4. WHEN a POST to the Whisper_Endpoint returns a 2xx response with a JSON body containing a non-empty `text` field, THE Whisper_Client SHALL append the trimmed value of `text` to the accumulated final transcript and SHALL invoke `renderTranscript()` to update the Transcript_Panel.
5. THE Whisper_Client SHALL append transcripts returned by concurrent in-flight POSTs to the accumulated final transcript in the order in which their source Audio_Chunks were emitted.
6. WHEN the user stops listening, THE Whisper_Client SHALL transition the listening state to `false` immediately AND SHALL POST any audio captured since the last chunk boundary as a final Audio_Chunk.
7. WHEN the final Audio_Chunk POST completes after listening has stopped, THE Whisper_Client SHALL append its returned transcript to the accumulated final transcript AND SHALL invoke `renderTranscript()` to update the Transcript_Panel.

### Requirement 3: Surface a single user-visible error when transcription fails

**User Story:** As a Lumen user, when transcription stops working I want one clear message in the transcript panel telling me why, so that I can take action without digging through logs.

#### Acceptance Criteria

1. IF no Groq_API_Key is present in `localStorage` under `lumen.key.groq` when the user clicks the `🎤 Listen` button to start listening, THEN THE Whisper_Client SHALL render a user-visible error in the Transcript_Panel via `showTranscriptError` identifying the missing Groq key AND SHALL leave the listening state unchanged at `false`.
2. IF a POST to the Whisper_Endpoint is rejected by `fetch` with a network error, THEN THE Whisper_Client SHALL render a user-visible error in the Transcript_Panel via `showTranscriptError` AND SHALL stop the active `MediaRecorder` AND SHALL transition the listening state to `false`.
3. IF a POST to the Whisper_Endpoint returns a non-2xx HTTP status, THEN THE Whisper_Client SHALL render a user-visible error in the Transcript_Panel via `showTranscriptError` including the HTTP status code and the first 300 characters of the response body AND SHALL stop the active `MediaRecorder` AND SHALL transition the listening state to `false`.
4. IF a 2xx response from the Whisper_Endpoint is not valid JSON or does not contain a string `text` field, THEN THE Whisper_Client SHALL render a user-visible error in the Transcript_Panel via `showTranscriptError` AND SHALL stop the active `MediaRecorder` AND SHALL transition the listening state to `false`.
5. WHEN the listening state transitions to `false` due to any error in this section, THE Renderer SHALL invoke `updateListenUI()` so the `🎤 Listen` button label and `🎤` badge reflect the stopped state.

### Requirement 4: Indicate transcription progress in the status line

**User Story:** As a Lumen user, I want a visible signal that audio is being transcribed, so that I trust the mic feature is working during the multi-second chunk round-trip.

#### Acceptance Criteria

1. WHEN listening starts and no Audio_Chunk POST is yet in flight, THE Renderer SHALL set the status line via `setStatus('listening…', true)`.
2. WHILE at least one Audio_Chunk POST is in flight, THE Renderer SHALL set the status line via `setStatus('transcribing…', true)`.
3. WHEN every in-flight Audio_Chunk POST has completed AND the listening state is `true`, THE Renderer SHALL set the status line via `setStatus('listening…', true)`.
4. WHEN listening stops cleanly with no remaining in-flight POST, THE Renderer SHALL set the status line via `setStatus('listening stopped', false)`.

### Requirement 5: Preserve the existing mic UI surface and permission flow

**User Story:** As a Lumen user, I want the same mic button, transcript panel, and prompt-injection actions I had before, so that the switch to Whisper does not change the UI I already know.

#### Acceptance Criteria

1. THE Renderer SHALL retain the `🎤 Listen` button as the sole entry point for starting and stopping mic transcription.
2. THE Renderer SHALL retain the `#transcript-text` panel as the rendering target for transcribed text.
3. THE Renderer SHALL retain the `Use as prompt`, `Append to prompt`, and `Clear` buttons with the same behaviors that operate on the accumulated transcript text.
4. THE Renderer SHALL CONTINUE TO render the Transcript_Panel via `renderTranscript()` whenever the accumulated final or interim transcript changes.
5. WHEN macOS mic permission is denied, THE Renderer SHALL CONTINUE TO call `L.openMicPerms()` to deep-link the macOS Privacy & Security pane.
6. THE Renderer SHALL CONTINUE TO operate non-mic features (chat backends, screen capture, hotkeys, click-through, content protection, IPC) without behavioral change introduced by this feature.

### Requirement 6: Configurable endpoint, model, and chunk duration

**User Story:** As a Lumen user with my own OpenAI-compatible Whisper deployment, I want to point Lumen at a different endpoint and model, so that I can use a self-hosted or alternative provider without forking the code.

#### Acceptance Criteria

1. THE Whisper_Client SHALL read the Whisper_Endpoint from `localStorage` key `lumen.whisper.endpoint`, defaulting to `https://api.groq.com/openai/v1/audio/transcriptions` when the key is absent or empty.
2. THE Whisper_Client SHALL read the Whisper_Model from `localStorage` key `lumen.whisper.model`, defaulting to `whisper-large-v3` when the key is absent or empty.
3. THE Whisper_Client SHALL read the Chunk_Duration_Seconds from `localStorage` key `lumen.whisper.chunkSeconds`, defaulting to 5 when the key is absent or empty.
4. IF the value stored under `lumen.whisper.chunkSeconds` cannot be parsed as a finite integer in the inclusive range [1, 30], THEN THE Whisper_Client SHALL use the default value of 5.
5. THE Whisper_Client SHALL read the Groq_API_Key from `localStorage` key `lumen.key.groq` independently of the currently selected chat backend.

### Requirement 7: Whisper as the sole mic transcription mechanism

**User Story:** As a Lumen maintainer, I want the Web Speech transcription path retired, so that the renderer does not carry restart-policy state and event handlers that no longer apply.

#### Acceptance Criteria

1. WHEN the user activates mic transcription via the `🎤 Listen` button, THE Renderer SHALL invoke the Whisper_Client as the sole transcription mechanism for that activation.
2. THE Renderer SHALL retain the `showTranscriptError`, `renderTranscript`, and `updateListenUI` helpers introduced by the previous bugfix as the user-visible primitives for the Whisper transcription flow.
3. WHEN listening starts under the Whisper_Client, THE Renderer SHALL initialize listening state without consulting the Web Speech-specific restart-policy fields (`MAX_ERROR_RESTARTS`, `MIN_CLEAN_SESSION_MS`, `consecutiveErrorRestarts`, `lastSessionStartedAt`, `lastError`) introduced by the previous bugfix.
