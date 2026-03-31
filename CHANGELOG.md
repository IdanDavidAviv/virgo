# Change Log

All notable changes to the "Readme Preview Read Aloud" extension will be documented in this file.

## [Unreleased]

### Added
- 

## [1.2.4] - 2026-03-31

### Added
- **Neural Voice Regression Suite**: Introduced `tests/vscode/speechProvider.voices.test.ts` to verify the voice discovery lifecycle and ensure high-integrity handshakes.

### Fixed
- **Voice Discovery Race Condition**: Resolved an issue where neural voices appeared missing during the initial background scan period by implementing a dedicated `voices` command handler in the dashboard.
- **UI Synchronization**: Hardened the communication between the extension and webview to ensure immediate voice dropdown population as soon as data is available.

## [1.2.3] - 2026-03-30

### Added
- **SSOT Architecture**: Promoted `StateStore` to the authoritative source for all playback, navigation, and configuration state, eliminating state drift.
- **Reactive Synchronization**: Refactored `DashboardRelay` and `SpeechProvider` to use a zero-parameter `sync()` method, triggered automatically by `StateStore` events.
- **State Resilience**: Consolidated and declared all missing state variables in `dashboard.js` to eliminate runtime crashes found in diagnostics.

### Changed
- **Stateless Webview**: Refactored `dashboard.js` to be purely reactive, removing all local state mirrors and relying entirely on `UI_SYNC` packets.
- **Hardened Volume Scaling**: Implemented nullish coalescing and range clamping in `dashboard.js` volume scaling to prevent `NaN` errors during initialization.

### Fixed
- **Dashboard Reference Errors**: Resolved `ReferenceError` crashes in the webview related to missing `isSynthesizing` and `currentChapterIndex` declarations.

## [1.2.2] - 2026-03-30

### Added
- **Regression Suite**: Introduced `tests/core/file_context_integrity.test.ts` for comprehensive UI data-flow and state synchronization verification.

### Changed
- **Relocated Status Indicator**: Moved the engine status dot from the Focused File slot to the global footer (bottom-right) for improved health visibility and cleaner separation of context.
- **Header Clean-up**: Removed redundant "NEURAL" text from the dashboard header for a more premium, focused UI.

### Fixed
- **Restored Version Badges**: Re-implemented version salt visibility (e.g., `V1`, `T-10:15`) in the Focused File slot to match v1.2.0 baseline behavior.

## [1.2.1] - 2026-03-30

### Added
- **Document-Level Persistence**: Integrated `vscode.globalState` to automatically save and restore reading positions (Chapter & Sentence) per document URI.
- **Improved Chapter Navigation**: 
    - **Row Progress Indicators**: Active chapter rows now feature a dynamic linear-gradient background representing sentence completion within that chapter.
    - **Header Blocking**: Chapters with 0 rows (headers) are now visually dimmed and interaction-locked to prevent playback errors.
    - **Pending Feedback**: Introduced a "Pending" highlight state for chapter jumps to provide instant visual confirmation before synthesis begins.

### Fixed
- **Play Button Flicker**: Eliminated the transient UI flicker during automatic sentence transitions by maintaining playback intent in the state synchronization layer.
- **UI Sync Stability**: Resolved a critical regression where the dashboard incorrectly parsed playback state after rapid navigation.
- **Type Safety**: Fixed a URI parsing mismatch in `SpeechProvider` persistence logic.
- **Diagnostic Hygiene**: Corrected inverted console log tags in the `DASHBOARD -> EXTENSION` bridge.

## [1.2.0] - 2026-03-30

### Added
- **Domain-Driven Architecture**: Decoupled the monolithic extension logic into isolated `@core`, `@vscode`, and `@webview` domains for ultimate stability and predictable path routing.
- **Global Path Aliasing**: Implemented high-integrity `tsconfig.json` mappings to eliminate brittle relative imports across all source files and test suites.

### Changed
- **Asset Centralization**: Consolidated all marketplace branding (`icon.png`, `dashboard_preview.png`) into a root `/assets` directory to separate runtime resources from repository metadata.

### Removed
- **Legacy Hygiene**: Executed a massive repository cleanup, purging over 4,600 lines of obsolete `media/` assets and orphaned logic controllers.

## [1.1.3] - 2026-03-29

### Added
- **Synthesis Resilience**: Implemented **Playback Intent IDs** to immediately eject stale tasks from the synthesis queue during rapid navigation.
- **WebSocket Recycling**: Added proactive `MsEdgeTTS` client re-initialization on 25s timeouts to clear persistent socket-level hangs.
- **Rate Limit Circuit Breaker**: Introduced explicit `429` (Too Many Requests) detection and a 60-second prefetch blackout during throttled states.
- **UI Navigation Debouncing**: Implemented a 350ms debounce on all navigation commands (`jump`, `next`, `prev`) in the dashboard to protect the engine from command storms.

### Changed
- **Retry Logic Hardening**: Restricted synthesis retries to priority tasks only, preventing background prefetch tasks from consuming quota after failure.
- **Interruptible Synthesis**: Optimized the `PlaybackEngine` lock to immediately release and abort in-flight tasks upon manual stop commands.

## [1.1.2] - 2026-03-29

### Added
- **Architectural Refactoring (Phase 3)**: Decoupled monolithic state from `SpeechProvider` into a centralized, reactive `StateStore`.
- **Atomic State Lifecycle**: Implemented `StateStore.reset()` to ensure synchronous, global state clearing and prevent session leakage.
- **Unit Testing Suite**: Established a dedicated `/tests` directory and integrated `vitest` for high-integrity logic verification (11/11 tests passing).
- **Logical Modularization**: Extracted document parsing and loading into a standalone `DocumentLoadController`.

### Changed
- **SpeechProvider**: Refactored to a pure coordinator pattern, delegating business logic and state management to isolated services.

## [1.1.1] - 2026-03-29

### Added
- **Neural Voice Caching Optimization**: Implemented voice-aware cache keys and persistent storage for audio data, enabling instant voice switching without re-synthesis.
- **Surgical Preview Mode**: Introduced a "Preview First" strategy for voice selection that synthesizes only the current sentence and defers document-wide prefetching.
- **Prefetch Guarding**: Throttled background synthesis tasks to prevent Azure TTS server exhaustion and state leakage during active playback.
- **Enhanced Diagnostics**: Added high-density shorthand logging for cache hits, cache misses, and synthesis lifecycle management.

## [1.1.0] - 2026-03-29

### Added
- **Serverless Architecture**: Fully decommissioned the legacy `BridgeServer` infrastructure, eliminating port collisions and installation locks on Windows.
- **Native Webview Messaging**: Migrated all extension-to-dashboard communication to the native VS Code `postMessage` protocol.
- **Improved UI Sync**: Restored the "Row X / Y" tracking and header state synchronization for a professional playback experience.
- **Direct Diagnostics**: Implemented a console-to-extension bridge to redirect webview logs directly to the "Read Aloud" output channel.
- **Voice Stabilization**: Standardized voice changes to immediately purge local audio caches and reset playback state.


## [1.0.3] - 2026-03-29

### Added
- **Selection Sync Multiplexer**: Implemented a 100ms debounced focus tracker in `extension.ts` to prevent race conditions during rapid tab switching or window resizing.
- **Ghost Focus Strategy**: Now prioritizes the active tab group's state when the sidebar is focused, ensuring the dashboard never loses context while you're interacting with it.
- **Enhanced Selection Guard**: Automatically clears "Focused File" area when an unsupported document type is active.

### Fixed
- **Dashboard Interactivity**: The **LOAD FILE** button now correctly disables (with a "ghosted" visual state) whenever "No Selection" is shown, providing clearer feedback on readable files.

## [1.0.2] - 2026-03-28

### Fixed
- **Webview Scoping**: Resolved fatal `ReferenceError` caused by incorrect block-scoping of DOM elements in `dashboard.js`.
- **Initialization Protocol**: Consolidated `acquireVsCodeApi()` calls and added a defensive handshake sequence to prevent startup crashes.
- **Expanded Recognition**: Relaxed document filters to support `.txt` and `.log` files in the Sidebar.
- **Diagnostic Layer**: Implemented a console-to-host logging bridge to capture and persist webview errors for rapid recovery.

### Removed
- **Redundant Commands**: Removed `readme-preview-read-aloud.read-selection` as selection handling is now integrated into the main flow.
- **Legacy Assets**: Deleted `media/simple.html`.

## [1.0.1] - 2026-03-28

### Fixed
- **Smart Port Isolation**: Dev sessions now use port 3002 to prevent handshake collisions with installed production instances.
- **Dynamic Versioning**: extension version is now dynamically injected from package.json into the dashboard.

### Removed
- **Neural Synthesis UI**: Cleaned up legacy premium toggles for a streamlined native experience.

## [1.0.0] - 2026-03-27

### Initial Release

- **Mission Control Dashboard**: Glassmorphism UI for session management.
- **Robust AST Parsing**: Accurate sentence mapping via `markdown-it`.
- **Intelligent Navigation**: Skip sentences, jump sections, or read from cursor.
- **Cross-Platform**: Support for Windows, macOS, and Linux native synthesis.
- **Resource Hygiene**: Proactive audio blob management for long sessions.
- **Production Bundling**: Optimized activation via `esbuild`.
