# Requirements Document

## Introduction

Lumen is a privacy-first AI overlay assistant. This feature delivers a focused UI polish pass on the existing Electron renderer (`renderer/index.html`, `renderer/renderer.js`) plus a small `main.js` change to register one new global hotkey. The pass bundles three related concerns that all touch the same surfaces:

1. A user-controlled three-state see-through opacity mode for the entire overlay window (the user's headline request).
2. Visual polish on the existing chrome: collapsible settings, consistent button states, hotkey tooltips, transcript-actions grouping, and tighter spacing.
3. Subtle CSS-only animations (fade, hover, expand/collapse, typing pulse, transcribing shimmer, opacity tween) that respect `prefers-reduced-motion`.

The goal is "feels nicer to use" without restructuring layout. The privacy and security model (lumen:// scheme, BYOK keys in localStorage, content-protection on capture) is unchanged.

### Out of Scope

The following are explicitly excluded from this spec and are deferred to future specs:

- Theme switcher (dark/light/system).
- Resizable panels.
- Major layout restructure (sidebars, tabs, multi-column views).
- New feature buttons beyond the Opacity_Cycle_Button.
- Auto-triggering opacity changes from screen-share or click-through state.
- Any new permission prompt; any analytics or telemetry.
- Screenshot region select, multi-monitor handling, system-audio transcription, custom screen-share picker, persistent chat history, local Whisper, animation libraries (Framer Motion or similar).

## Glossary

- **Lumen Overlay**: The single Electron `BrowserWindow` instance Lumen renders into.
- **Main_Process**: Electron main-process code in `main.js`.
- **Renderer**: Renderer-process code in `renderer/index.html` + `renderer/renderer.js`.
- **Hotkey_Manager**: The `globalShortcut.register` registry in `Main_Process`.
- **Title_Bar**: The draggable header strip at the top of the overlay containing the Lumen badge and status icons.
- **Chat_Panel**: The scrollable message list in `#chat`.
- **Command_Panel**: The bottom region in `.cmd` containing settings, previews, transcript, input, and action buttons.
- **Settings_Panel**: The `<details>` block holding backend, model, API key, and Ollama URL controls.
- **Transcript_Panel**: The mic-transcript surface (`#transcript-wrap`) shown while Whisper_Client is active.
- **Transcript_Action_Toolbar**: The grouped row of transcript actions (Use_As_Prompt_Button, Append_To_Prompt_Button, Clear_Transcript_Button) within the Transcript_Panel.
- **Status_Line**: The text status indicator in the Title_Bar (`#status`).
- **Window_Opacity**: The opacity level of the entire Lumen Overlay window, applied via Electron's `BrowserWindow.setOpacity`.
- **Opacity_Cycle**: The fixed ordered list of allowed Window_Opacity levels: 100%, 70%, 40%.
- **Opacity_Controller**: The renderer module responsible for advancing through the Opacity_Cycle, persisting the choice, requesting Main_Process to apply it, and updating the Opacity_Badge.
- **Opacity_Cycle_Button**: The button in the Command_Panel that advances through the Opacity_Cycle.
- **Opacity_Badge**: The visual indicator (badge or icon) in the Title_Bar showing the current Window_Opacity level.
- **Listen_Button**: `#listen` (toggles Whisper transcription).
- **Share_Screen_Button**: `#share` (toggles screen capture).
- **Send_Button**: `#send` ("Ask").
- **Clear_Chat_Button**: `#clear`.
- **Save_Key_Button**: `#savekey`.
- **Forget_Key_Button**: `#clearkey`.
- **Check_Connection_Button**: `#ping`.
- **Use_As_Prompt_Button**: `#transcript-use`.
- **Append_To_Prompt_Button**: `#transcript-append`.
- **Clear_Transcript_Button**: `#transcript-clear`.
- **Typing_Indicator**: The placeholder shown in an assistant chat bubble while it waits for the first streamed token (the existing `…` / cursor element).
- **Whisper_Client**: The renderer's mic-transcription pipeline already implemented in `renderer.js` (`startWhisper`, `postChunk`, etc.).
- **Click_Through_Mode**: The mouse-passthrough state toggled by ⌘⇧T.

## Requirements

### Requirement 1: Cycle through three opacity states via button

**User Story:** As a user, I want to click a button in the command panel to cycle the overlay's opacity through 100%, 70%, and 40%, so that I can see what is behind Lumen without moving or hiding the window.

#### Acceptance Criteria

1. THE Command_Panel SHALL render an Opacity_Cycle_Button positioned alongside the existing action buttons (Listen_Button, Share_Screen_Button, Clear_Chat_Button, Send_Button).
2. THE Opacity_Controller SHALL maintain Window_Opacity as one of exactly three levels: 100%, 70%, or 40%.
3. WHILE Window_Opacity equals 100%, WHEN the Opacity_Cycle_Button is activated, THE Opacity_Controller SHALL set Window_Opacity to 70%.
4. WHILE Window_Opacity equals 70%, WHEN the Opacity_Cycle_Button is activated, THE Opacity_Controller SHALL set Window_Opacity to 40%.
5. WHILE Window_Opacity equals 40%, WHEN the Opacity_Cycle_Button is activated, THE Opacity_Controller SHALL set Window_Opacity to 100%.
6. WHEN Window_Opacity changes, THE Opacity_Controller SHALL apply the new level to the entire Lumen Overlay window via `BrowserWindow.setOpacity` (not via CSS opacity on the body).

### Requirement 2: Cycle opacity via global hotkey

**User Story:** As a user, I want a global hotkey to cycle the overlay's opacity, so that I can change opacity without moving my pointer to the button.

#### Acceptance Criteria

1. WHERE the platform is macOS, THE Hotkey_Manager SHALL register `Cmd+Shift+O` as a global hotkey.
2. WHERE the platform is Windows or Linux, THE Hotkey_Manager SHALL register `Ctrl+Shift+O` as a global hotkey.
3. WHEN the registered opacity hotkey fires, THE Opacity_Controller SHALL advance Window_Opacity to the next level in the Opacity_Cycle using the same transitions defined in Requirement 1.
4. THE Hotkey_Manager SHALL NOT bind the opacity hotkey to any chord that conflicts with the existing global hotkeys `Cmd/Ctrl+Shift+Space`, `Cmd/Ctrl+Shift+L`, `Cmd/Ctrl+Shift+T`, `Cmd/Ctrl+Shift+Up`, `Cmd/Ctrl+Shift+Down`, `Cmd/Ctrl+Shift+Left`, or `Cmd/Ctrl+Shift+Right`.
5. IF the opacity hotkey fails to register at startup, THEN THE Main_Process SHALL log a warning to stderr and continue without halting application startup.

### Requirement 3: Show the current opacity level

**User Story:** As a user, I want to see which opacity level is currently active, so that I know what state Lumen is in before I press the cycle button or hotkey again.

#### Acceptance Criteria

1. THE Title_Bar SHALL render an Opacity_Badge that displays the current Window_Opacity level as one of the labels "100%", "70%", or "40%".
2. WHEN Window_Opacity changes, THE Opacity_Badge SHALL update its displayed label within 100 ms of the change.
3. THE Opacity_Badge SHALL use a visual treatment consistent with the existing Title_Bar badges (`#eye`, `#ear`, `#ct-badge`).

### Requirement 4: Persist the chosen opacity across restarts

**User Story:** As a user, I want Lumen to remember my last opacity choice between launches, so that I do not have to re-cycle every time I open the app.

#### Acceptance Criteria

1. WHEN Window_Opacity changes, THE Opacity_Controller SHALL write the chosen level to localStorage under the key `lumen.opacity` as one of the strings `"100"`, `"70"`, or `"40"`.
2. WHEN the Renderer initializes, THE Opacity_Controller SHALL read `lumen.opacity` from localStorage and set Window_Opacity to that value.
3. IF `lumen.opacity` is absent from localStorage, THEN THE Opacity_Controller SHALL set Window_Opacity to 100%.
4. IF `lumen.opacity` holds any value other than `"100"`, `"70"`, or `"40"`, THEN THE Opacity_Controller SHALL set Window_Opacity to 100% and overwrite the stored value with `"100"`.

### Requirement 5: Keep opacity strictly user-driven

**User Story:** As a user, I want opacity to change only when I explicitly ask for it, so that screen sharing or click-through never surprises me with a sudden visibility change.

#### Acceptance Criteria

1. THE Opacity_Controller SHALL change Window_Opacity only in response to activation of the Opacity_Cycle_Button or the opacity hotkey.
2. WHEN screen sharing starts or stops, THE Opacity_Controller SHALL leave Window_Opacity unchanged.
3. WHEN Click_Through_Mode toggles, THE Opacity_Controller SHALL leave Window_Opacity unchanged.
4. WHEN Whisper_Client starts or stops, THE Opacity_Controller SHALL leave Window_Opacity unchanged.

### Requirement 6: Smooth opacity transition

**User Story:** As a user, I want opacity changes to ease in instead of snapping, so that the visual change does not feel jarring.

#### Acceptance Criteria

1. WHEN Window_Opacity changes, THE Lumen Overlay SHALL transition from the previous level to the new level over a duration between 150 ms and 300 ms.
2. THE opacity transition SHALL run at no fewer than 30 frames per second on the developer's reference hardware.

### Requirement 7: Collapsible backend settings

**User Story:** As a user, I want the backend settings (backend, model, API key, Ollama URL) tucked into an expandable section, so that the chat area gets more vertical room by default.

#### Acceptance Criteria

1. THE Settings_Panel SHALL be collapsed on first launch (when no prior expansion preference is recorded).
2. WHEN the user activates the Settings_Panel header, THE Settings_Panel SHALL toggle between expanded and collapsed.
3. WHILE the Settings_Panel is collapsed, THE Settings_Panel SHALL hide the backend selector, model field, model hint, API key field, Ollama URL field, Save_Key_Button, Forget_Key_Button, and Check_Connection_Button from view.
4. WHILE the Settings_Panel is collapsed, THE Settings_Panel SHALL still render its summary header so the user can re-expand it.
5. WHEN the Settings_Panel toggles, THE Settings_Panel SHALL animate the size change over a duration between 200 ms and 300 ms.

### Requirement 8: Consistent button visual language

**User Story:** As a user, I want every button in the command and transcript panels to share the same visual vocabulary for inactive, hover, active, and disabled states, so that the interface feels coherent.

#### Acceptance Criteria

1. THE Renderer SHALL apply a single shared visual style across all four interaction states (inactive, hover, active, disabled) for the following controls: Listen_Button, Share_Screen_Button, Send_Button, Clear_Chat_Button, Save_Key_Button, Forget_Key_Button, Check_Connection_Button, Use_As_Prompt_Button, Append_To_Prompt_Button, Clear_Transcript_Button, and Opacity_Cycle_Button.
2. WHILE Listen_Button is in the active state (Whisper_Client is listening), THE Listen_Button SHALL render with the shared "active" style defined by this requirement.
3. WHILE Share_Screen_Button is in the active state (screen sharing is on), THE Share_Screen_Button SHALL render with the shared "active" style defined by this requirement.
4. WHEN the user hovers a pointer over any control listed in Acceptance Criterion 1, THE Renderer SHALL apply the shared "hover" style and animate the change over a duration between 150 ms and 300 ms.
5. WHILE any control listed in Acceptance Criterion 1 is disabled, THE Renderer SHALL apply the shared "disabled" style and SHALL suppress hover and active styling on that control.

### Requirement 9: Hotkey and function tooltips

**User Story:** As a user, I want to hover a button and see what it does plus its hotkey if any, so that I do not have to read the README to discover keyboard shortcuts.

#### Acceptance Criteria

1. THE Send_Button SHALL declare a native `title` attribute that includes the text "Cmd+Enter" on macOS or "Ctrl+Enter" on other platforms.
2. THE Opacity_Cycle_Button SHALL declare a native `title` attribute that includes the text "Cmd+Shift+O" on macOS or "Ctrl+Shift+O" on other platforms.
3. THE Listen_Button, Share_Screen_Button, Clear_Chat_Button, Save_Key_Button, Forget_Key_Button, Check_Connection_Button, Use_As_Prompt_Button, Append_To_Prompt_Button, and Clear_Transcript_Button SHALL each declare a native `title` attribute describing the button's action in plain English.
4. THE Renderer SHALL NOT add any third-party tooltip library to satisfy this requirement.

### Requirement 10: Visually distinct transcript actions toolbar

**User Story:** As a user, I want the transcript-action buttons grouped into a toolbar that is visually separate from the transcript text, so that I can tell controls apart from content at a glance.

#### Acceptance Criteria

1. THE Transcript_Panel SHALL render the Use_As_Prompt_Button, Append_To_Prompt_Button, and Clear_Transcript_Button inside a Transcript_Action_Toolbar element.
2. THE Transcript_Action_Toolbar SHALL be positioned above the transcript text area within the Transcript_Panel.
3. THE Transcript_Action_Toolbar SHALL apply at least one visual treatment that separates it from the transcript text area: a distinct background color, a top or bottom divider rule, or a contained padding/border grouping.

### Requirement 11: Tightened spacing in chat and command panels

**User Story:** As a user, I want chat bubbles to have breathing room and the command panel to stop wasting vertical space on collapsed settings, so that the layout feels uncluttered.

#### Acceptance Criteria

1. THE Chat_Panel SHALL render at least 8 px of vertical spacing between consecutive chat bubbles.
2. WHILE the Settings_Panel is collapsed, THE Command_Panel SHALL not allocate vertical space to the controls listed in Requirement 7 Acceptance Criterion 3 beyond the Settings_Panel summary header.
3. THE Settings_Panel summary header SHALL occupy no more than 40 px of vertical space when collapsed.

### Requirement 12: Chat bubble fade-in

**User Story:** As a user, I want new chat messages to fade in smoothly, so that the chat area does not flicker when content arrives.

#### Acceptance Criteria

1. WHEN a new user message is appended to the Chat_Panel, THE Renderer SHALL animate the message element from 0 to 1 opacity over a duration between 200 ms and 300 ms.
2. WHEN a new assistant message is appended to the Chat_Panel, THE Renderer SHALL animate the message element from 0 to 1 opacity over a duration between 200 ms and 300 ms.
3. THE Renderer SHALL implement the fade-in using CSS transitions or CSS keyframe animations only, with no JavaScript animation library.

### Requirement 13: Animated typing indicator

**User Story:** As a user, I want the assistant placeholder to pulse while waiting for the first streamed token, so that I know the model is working.

#### Acceptance Criteria

1. WHILE an assistant chat bubble has been appended but no streamed token has yet been rendered into it, THE Renderer SHALL display a Typing_Indicator inside that bubble.
2. THE Typing_Indicator SHALL animate with a continuous pulse or shimmer effect using CSS animations only.
3. WHEN the first streamed token is rendered into the assistant bubble, THE Renderer SHALL remove or hide the Typing_Indicator within 100 ms.

### Requirement 14: Loading shimmer for in-flight transcription

**User Story:** As a user, I want a shimmer on the transcript panel while Whisper chunks are uploading, so that I know transcription is in progress and not stalled.

#### Acceptance Criteria

1. WHILE the Status_Line text is `transcribing…`, THE Transcript_Panel SHALL display a shimmer animation on the transcript text area.
2. WHEN the Status_Line text changes to any value other than `transcribing…`, THE Transcript_Panel SHALL stop the shimmer animation.
3. THE shimmer animation SHALL be implemented using CSS animations only.

### Requirement 15: Respect reduced-motion accessibility preference

**User Story:** As a user with motion sensitivity, I want all Lumen animations to be disabled when my OS reports `prefers-reduced-motion: reduce`, so that the interface does not trigger discomfort.

#### Acceptance Criteria

1. IF the user agent reports `prefers-reduced-motion: reduce`, THEN THE Renderer SHALL disable the chat bubble fade-in animation defined in Requirement 12.
2. IF the user agent reports `prefers-reduced-motion: reduce`, THEN THE Renderer SHALL disable the Settings_Panel expand/collapse animation defined in Requirement 7.
3. IF the user agent reports `prefers-reduced-motion: reduce`, THEN THE Renderer SHALL disable the button hover transition defined in Requirement 8.
4. IF the user agent reports `prefers-reduced-motion: reduce`, THEN THE Renderer SHALL disable the Typing_Indicator pulse defined in Requirement 13.
5. IF the user agent reports `prefers-reduced-motion: reduce`, THEN THE Renderer SHALL disable the transcribing shimmer defined in Requirement 14.
6. IF the user agent reports `prefers-reduced-motion: reduce`, THEN THE Lumen Overlay SHALL apply Window_Opacity changes as an instant set with no transition.
7. WHILE `prefers-reduced-motion: reduce` is set, THE state changes those animations represent (message appended, panel collapsed, button activated, transcription running, opacity changed) SHALL still take effect — only the animated transitions are suppressed.

### Requirement 16: Preserve privacy and BYOK model

**User Story:** As a privacy-conscious user, I want this UI pass to add zero new data collection or external traffic, so that Lumen's BYOK promise is unchanged.

#### Acceptance Criteria

1. THE Opacity_Controller SHALL store Window_Opacity preferences only in renderer-local localStorage under the key `lumen.opacity`.
2. THE Renderer SHALL NOT introduce any analytics, telemetry, crash reporting, or remote logging as part of this feature.
3. THE Renderer SHALL NOT issue any network request as part of the opacity feature, the polish pass, or the animations.
4. THE Renderer SHALL invoke `L.openMicPerms()` only when a microphone permission denial is detected during Whisper_Client startup, matching the existing behavior in `reportError('mic-denied', …)`.
5. THE Renderer SHALL NOT trigger any new operating-system permission prompt as part of this feature.

### Requirement 17: Coexist with existing window behavior

**User Story:** As a user who already relies on click-through and content-protection, I want the see-through opacity feature to coexist with those, so that I do not lose existing capabilities.

#### Acceptance Criteria

1. WHEN Window_Opacity is at 70% or 40%, THE Lumen Overlay SHALL continue to honor `setContentProtection(true)` so the window remains hidden from screen capture.
2. WHEN Window_Opacity is at 70% or 40%, THE Lumen Overlay SHALL continue to respect Click_Through_Mode independently (Click_Through_Mode and Window_Opacity are independent axes).
3. WHEN Window_Opacity changes, THE Lumen Overlay SHALL preserve its current position, size, always-on-top status, and visible-on-all-workspaces status.
