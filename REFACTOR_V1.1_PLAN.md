# Refactoring Path: Native Webview Migration (v1.1)

This plan outlines the migration from the `BridgeServer` architecture to a native VS Code Webview architecture. The primary goal is to eliminate file locks and port collisions on Windows by removing the dependency on a local HTTP/WebSocket server.

## User Review Required

> [!IMPORTANT]
> **Architectural Shift**: We are moving from a Server-Client model to a Native API model.
> - **Removal of Bridge**: The `BridgeServer` will no longer be started by default.
> - **Asset Loading**: Styles and scripts will be loaded via `asWebviewUri`.
> - **Communication**: WebSocket logic in `dashboard.js` will be deprecated in favor of `postMessage`.

> [!WARNING]
> **CSP Restrictions**: Native webviews have stricter Content Security Policy (CSP) requirements. I will need to carefully define the CSP to allow `blob:` URIs for audio playback.

## Proposed Changes

### [Component] Extension Lifecycle

#### [MODIFY] [extension.ts](file:///c:/Users/Idan4/Desktop/readme-preview-read-aloud/src/extension.ts)
- Modify `activate` to make `BridgeServer` optional or disable it.
- Ensure `deactivate` still attempts to stop any running server (for backward compatibility during migration).

---

### [Component] Speech Provider & Webview

#### [MODIFY] [speechProvider.ts](file:///c:/Users/Idan4/Desktop/readme-preview-read-aloud/src/speechProvider.ts)
- Implement `_getHtmlForWebview` method that uses `webview.asWebviewUri` for `style.css` and `dashboard.js`.
- Update `resolveWebviewView` to use the new HTML generation logic.
- Remove calls to `this._bridge.broadcast()` and rely solely on `this._view.webview.postMessage()`.

#### [MODIFY] [media/speechEngine.html](file:///c:/Users/Idan4/Desktop/readme-preview-read-aloud/media/speechEngine.html)
- Replace injected script/style placeholders with standard tags using template variables (e.g., `${styleUri}`, `${scriptUri}`).

---

### [Component] Dashboard Script

#### [MODIFY] [media/dashboard.js](file:///c:/Users/Idan4/Desktop/readme-preview-read-aloud/media/dashboard.js)
- Ensure all logic prioritizes `window.vscode` over WebSocket.
- Add an initialization handshake message if needed to sync state upon loading.
- **FIX**: Align `setVoice` command from dashboard with `voiceChanged` handler in `SpeechProvider.ts`.

### [Component] Audio Engine & Cache Handling

#### [MODIFY] [playbackEngine.ts](file:///c:/Users/Idan4/Desktop/readme-preview-read-aloud/src/playbackEngine.ts)
- Update `clearCache()` to reset `_cacheSizeBytes = 0`.

#### [MODIFY] [speechProvider.ts](file:///c:/Users/Idan4/Desktop/readme-preview-read-aloud/src/speechProvider.ts)
- In `_handleWebviewMessage`, add `this._playbackEngine.clearCache()` and `this.stop()` to the `voiceChanged` case.
- This ensures that changing the voice invalidates pre-synthesized segments and stops the current playback immediately.

## Open Questions

- Should we keep a "Legacy Mode" setting in `package.json` to allow users to force the `BridgeServer` if they encounter issues?
- Are there any external tools (like the dashboard) that *must* access the bridge server from outside VS Code? If so, we might need a "Remote Access" option.

## Verification Plan

### Automated Tests
- No automated tests currently exist for the UI, but I will perform:
  - `npm run compile` to check for type errors.
  - Manual verification of the UI in the development host.

### Manual Verification
1.  **Launch Extension**: Verify that "Read Aloud" sidebar appears.
2.  **Load Document**: Verify that clicking "Load Current Document" works.
3.  **Playback**: Verify that speech synthesis works (audio blob loading).
4.  **Windows Atomic Update**: (Simulated) Verify that the extension directory is not locked when the extension is active.
