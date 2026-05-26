# Bugfix Requirements Document

## Introduction

Mic transcription in the Lumen macOS Electron overlay is non-functional. When the user activates the mic, the Web Speech API session errors out immediately and no interim or final transcripts ever appear in the transcript panel. The renderer console shows a repeating chunked-upload network failure (`OnSizeReceived failed with Error: -2`, i.e. `net::FAILED`) emitted roughly every 600ms from `chunked_data_pipe_upload_data_stream.cc`, with the cadence amplified by the existing ~60s auto-restart loop re-triggering the same failure.

The Web Speech API streams microphone audio to Google's speech recognition endpoint over a chunked HTTP upload, so a failure in that upload pipeline causes the recognition session to abort before any transcript is produced. The user-visible result is a mic feature that appears active but produces no output.

This bugfix scopes to restoring Web Speech-based transcription in the current build. Replacing Web Speech with a local or self-hosted speech engine (e.g. Whisper, Groq) is a separate roadmap item and is explicitly out of scope here.

## Bug Analysis

### Current Behavior (Defect)

When the user starts mic transcription, the Web Speech recognition session fails immediately due to a chunked HTTP upload failure to Google's speech endpoint, and no transcript is ever displayed.

1.1 WHEN the user activates the mic and a `SpeechRecognition` session is started THEN the system fails the underlying chunked HTTP upload with `net::FAILED` (`OnSizeReceived failed with Error: -2`) before any audio is recognized
1.2 WHEN the chunked upload fails THEN the system never emits any interim transcript results to the transcript panel
1.3 WHEN the chunked upload fails THEN the system never emits any final transcript results to the transcript panel
1.4 WHEN the recognition session aborts due to the upload failure THEN the system's auto-restart loop re-triggers a new session that fails identically, producing the repeating ~600ms cadence of `chunked_data_pipe_upload_data_stream.cc` errors in the console
1.5 WHEN the recognition session aborts due to the upload failure THEN the system does not surface a clear, user-facing indication that mic transcription is non-functional

### Expected Behavior (Correct)

When the user starts mic transcription, the Web Speech recognition session SHALL successfully stream audio and produce transcripts, or SHALL fail gracefully with a clear user-facing signal when transcription cannot be performed.

2.1 WHEN the user activates the mic and a `SpeechRecognition` session is started THEN the system SHALL establish a working audio upload to the speech endpoint without `net::FAILED` errors on the chunked upload pipeline
2.2 WHEN the user speaks into the mic during an active session THEN the system SHALL emit interim transcript results to the transcript panel
2.3 WHEN the user finishes an utterance during an active session THEN the system SHALL emit a final transcript result to the transcript panel
2.4 WHEN a recognition session ends normally (e.g. ~60s rotation) THEN the system SHALL restart a new session that also produces transcripts, without entering a tight error-restart loop
2.5 WHEN the chunked upload genuinely cannot be established (e.g. offline, endpoint unreachable) THEN the system SHALL surface a clear user-facing error in the transcript panel and SHALL NOT silently spin in an auto-restart loop

### Unchanged Behavior (Regression Prevention)

Existing non-mic and adjacent mic-permission behavior that currently works correctly must be preserved.

3.1 WHEN macOS mic permission is denied THEN the system SHALL CONTINUE TO deep-link the user to the macOS mic permission settings via the existing `openMicPerms` flow
3.2 WHEN the transcript panel receives transcript results THEN the system SHALL CONTINUE TO render live interim and final transcripts in the panel using the existing rendering logic
3.3 WHEN the user is not using the mic feature THEN the system SHALL CONTINUE TO operate the rest of the overlay assistant unaffected
3.4 WHEN the user manually stops mic transcription THEN the system SHALL CONTINUE TO end the recognition session and stop the auto-restart loop as it does today
3.5 WHEN a recognition session reaches the ~60s mark during normal operation THEN the system SHALL CONTINUE TO rotate to a fresh session to work around Web Speech's session-length limits
