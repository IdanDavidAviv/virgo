# Restoration Plan: PlaybackController

This file is a local copy of the implementation plan for your visibility in the project root.

## Goal
Restore the missing `src/webview/playbackController.ts` and align the modern modular architecture with the stable logic from `dashboard.js`.

## Proposed Changes

### 1. Restore `src/webview/playbackController.ts`
- Pattern: Singleton.
- Logic: 3.5s watchdog for sync locks, `CONTINUE` vs `LOAD_AND_PLAY` actions.

### 2. Update Infrastructure
- **CommandDispatcher**: Delegate `UI_SYNC` to the new controller.
- **PlaybackControls**: Route user actions through the new controller.
- **WebviewAudioEngine**: De-clutter and focus on raw audio management.

## Verification
- Automated tests (`npm test`).
- Manual sync/loading state checks.
