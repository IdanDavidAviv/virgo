# Change Log

All notable changes to the "Readme Preview Read Aloud" extension will be documented in this file.

## [Unreleased]

### Added
- 

## [1.5.3] - 2026-04-02

### Added
- 

## [1.5.3] - 2026-04-03

### Added
- **Chapter List UI Polish**:
    - Improved visual hierarchy with refined multi-level indentation (H1: 12px, H2: 24px, H3: 36px).
    - Integrated interactive file links (`[label](file:///...)`) into chapter titles with premium, embedded styling.
    - Implemented a "Link-First" click priority to prevent unwanted chapter jumps when interacting with file links.
- **Keyboard Navigation Debouncing**:
    - Implemented a 100ms throttle for navigation keys (`ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`) to prevent command flooding and extension host overhead during key-hold events.

### Fixed
- **XML/SSML Synthesis Integrity (Issue #36)**:
    - Implemented robust pre-filtration for ampersands (`&amp;`), tag delimiters (`<`/`>`), and quotes to ensure safe delivery to the Neural TTS engine.
    - Centralized sanitization logic in `speechProcessor.ts` with comprehensive regression tests.

## [1.5.2] - 2026-04-02

### Added
- **Premium UI Restoration**:
    - Restored **Glassmorphism** effects and deep transparency to the settings drawer.
    - Implemented a custom, searchable **Voice Selector** with neural voice indicators (✨).
    - Added real-time numeric feedback for speed and volume sliders.
- **Testing Stability Infrastructure**:
    - Added `dispose()` methods to `MessageClient`, `WebviewStore`, and `ToastManager` for high-integrity lifecycle management.
    - Introduced a global `vitest.setup.ts` to provide `indexedDB` and `scrollIntoView` mocks for the JSDOM environment.

### Fixed
- **Testing Memory Leaks**: Resolved systemic event listener accumulation and pending timer leaks in the webview components.
- **Audio Defaults**: Enforced safe startup defaults (`rate: 0`, `volume: 50%`) to prevent audio clipping and playback drift.

## [1.5.0] - 2026-04-02

### Added
- **Dashboard Modularization (Phase 5.4)**: Extracted all remaining UI logic from the monolithic `dashboard.js` into strictly-typed, reactive ESM components: `PlaybackControls`, `SettingsDrawer`, `VoiceSelector`, `FileContext`, and `ToastManager`.
- **Regression Test Suite (19 tests)**: Added `PlaybackControls.test.ts` (status-dot lifecycle), `WebviewStore.patchState.test.ts` (surgical IPC updates), and `utils.test.ts` (`renderWithLinks` + `escapeHtml` XSS guards). Total: 134 tests.
- **Log Sanitizer**: Ported `logSafeMessage()` into `dashboard.js` — truncates binary blobs to `[BIN:NKB]`, shortens `file:///` paths to basename, collapses large arrays to `[CNT:N]`.

### Fixed
- **Status-Dot Engine Indicator**: Restored the `#status-dot` engine health indicator in `PlaybackControls`, toggling `online`/`stalled`/idle classes to match legacy behaviour.
- **Voices IPC Handler**: Restored the `voices` command handler in `dashboard.js` using `store.patchState()` to surgically update `availableVoices` without a full `UI_SYNC` cycle.
- **Slider Drag Guard**: Added `isDraggingSlider` flag in `SettingsDrawer` — `oninput` sets the flag, `onchange` clears it; `WebviewStore` subscriptions skip slider updates while dragging to prevent snap-back.
- **Live Rate Preview**: Rate slider `oninput` now directly updates `neuralPlayer.playbackRate` for instant audio speed feedback during drag.
- **Engine Toggle Group Sync**: `engineToggleGroup` is now shown/hidden alongside the settings drawer open/close transition.
- **Drawer Auto-Close on Load**: `FileContext` now closes the settings drawer after clicking "Load File", matching legacy behaviour.
- **Autoplay Restoration**: `PlaybackController` correctly signals `SENTENCE_ENDED` via `audio.onended`/`audio.onerror` to drive the autoplay chain.
- **STOP & PLAYBACK_STATE_CHANGED Handlers**: Restored both IPC command handlers in `dashboard.js`.
- **WebviewStore.patchState**: Added public `patchState()` method for targeted state updates from lightweight IPC commands.

## [1.4.5] - 2026-04-02

### Added
- **Dashboard Modularization (Phase 5.3)**: Extracted `SentenceNavigator` logic into a strictly-typed, reactive TypeScript component.
- **Webview Component Infrastructure**: Introduced `BaseComponent` abstract class to standardize lifecycle hooks and `WebviewStore` subscription management.
- **Enhanced UI Snap-back**: Integrated internal "Pending Jump" state in `SentenceNavigator` for immediate visual feedback during playback navigation.

## [1.4.4] - 2026-04-02

### Fixed
- **Markdown List Index Parsing (Issue #31)**: Implemented a position-aware, reinforced regex strategy to prevent multi-level indices (e.g., `1.1.`), Roman numerals, and mid-paragraph list markers from being incorrectly segmented as sentences.

## [1.4.3] - 2026-04-02

### Added
- **ESM Modularization Infrastructure (Phase 1 & 2)**: 
    - **Reactive State Management**: Introduced `WebviewStore` with selector-based subscriptions for high-performance UI updates.
    - **Resilient IPC Bridge**: Implemented `MessageClient` singleton to unify extension-to-dashboard communication.
    - **Consolidated IPC Protocol**: Unified all IPC commands via shared TypeScript Enums for improved maintainability.

### Fixed
- **Dashboard Initialization Race**: Resolved a critical startup failure caused by a VS Code API singleton violation and script execution order.

## [1.4.2] - 2026-04-02

### Added
- **Unicode Emoji Filtering (Issue #27)**: Implemented Unicode-aware suppression of emojis, flags, and skin tone modifiers to ensure clear, distraction-free speech synthesis.
- **Smart-Logic Navigation**: 
    - `ArrowUp` now intelligently restarts the current chapter if work is in progress, or jumps back if already at the start.
    - Implemented hardware-level key repeat guards to prevent command flooding and audio stutter in the dashboard.

### Fixed
- **Atomic Chapter Navigation (Issue #28)**: Resolved a core logic leak where chapter-level keyboard shortcuts were incorrectly triggering sentence-level skips.

## [1.4.1] - 2026-04-01

### Added
- **Premium Playback Animations (Issue #22)**:
    - Added `.is-loading` CSS spinner for Play/Pause buttons during neural synthesis and IPC sync locks.
    - Added `.stalled` "Spectral Glow" pulse for the sentence navigator to provide clear feedback during delays.
- **UI Logic Regression Suite**: Introduced `tests/webview/uiSync.test.ts` to verify state transitions and visibility logic.

### Fixed
- **Control Alignment**: Corrected "off-center" playback icon layout and normalized button widths for a balanced toolbar experience.
- **State Reconciliation**: Refactored UI logic into a strictly-typed TypeScript `UIManager` to eliminate race conditions and state-flicker.

## [1.4.0] - 2026-04-01

### Added
- **Rapid-Playback Engine (Zero-IPC Phase 2)**:
    - **Intent-Ejection Protocol**: Instant termination of stale synthesis tasks during rapid document navigation, eliminating "Ghost Audio".
    - **Zero-Handshake Ingestion**: Optimized `AudioBridge` to trigger webview cache checks immediately upon navigation.
    - **Concurrent Task Deduping**: Shared task tracking for identical text segments, preventing redundant Azure TTS calls.
- **Neural Stability Watchdog**:
    - **MsEdgeTTS Recycling**: Automated client re-initialization and socket clearing on synthesis timeouts.
    - **Buffering Telemetry**: New `engineStatus: 'buffering'` event for improved UI feedback during network recovery.
- **Atomic UI-Sync**: Hardened synchronization between the extension host and webview state.

## [1.3.2] - 2026-03-31

### Added
- **Content-Aware State Persistence (Issue #25)**:
    - **MD5 Integrity Fingerprinting**: Implemented automated, platform-agnostic document hashing to track content changes, ensuring reading progress accurately resets on file modification.
    - **Composite Key Protocol**: Migrated storage from URI-only keys to `[URI]#[SALT]#[HASH]` mapping for collision-free state tracking.
    - **Passive Migration Gate**: Seamless, automatic upgrade path for existing user progress without data loss.
    - **Scoped Garbage Collection**: Added "Same-File Priority" management to the persistence layer, optimizing the 50-entry storage limit.

### Fixed
- **Atomic Index Reset**: Hardened the document activation protocol to eliminate UI flicker and index drift during fast file switching.

## [1.3.1] - 2026-03-31

### Fixed
- **Issue #25 (Atomic Index Reset)**: Resolved a critical offset persistence bug by implementing an atomic document activation protocol, ensuring consistent initialization and zero-flicker UI transitions.

## [1.3.0] - 2026-03-31

### Added
- **Sound & Visual Link Bridge**:
    - **Audio Gate Sanitization**: Automated stripping of markdown-style file URIs (`(file:///...)`) from speech synthesis, ensuring a natural reading experience while preserving the labels.
    - **Visual Link Bridge**: Transformed raw file URIs in the dashboard into premium, clickable links for instant navigation back to the editor.
    - **Navigation Bridge**: Integrated a bi-directional command layer (`OPEN_FILE`) between the webview and VS Code for seamless file management.

## [1.2.7] - 2026-03-31

### Added
- **Background Playback Persistence**: Enabled critical playback command whitelisting in `DashboardRelay.ts`, ensuring audio continuity even when the sidebar is hidden.
- **Dirty State Tracking**: Implemented a "needs sync" flag in `SpeechProvider.ts` to suppress redundant UI synchronization and prevent jarring resets upon revealing the sidebar.

### Fixed
- **UI Thrashing & Jumps**: Optimized `dashboard.js` with shallow state comparison and viewport-aware "smart" scrolling to eliminate unwanted jumps and flicker during playback.
- **Chapter List Loading**: Resolved a state-racing bug in the webview where the chapter list occasionally failed to render due to invalid assignment timing.

## [1.2.6] - 2026-03-31

### Added
- **Webview Protocol Guard**: Implemented defensive checks in `dashboard.js` to detect and report missing `cacheKey` or audio data, preventing silent playback failures.
- **Granular Synthesis Logging**: Added positional metrics (`CH:X SN:Y`) to synthesis error reports for high-resolution troubleshooting of neural voice issues.

### Fixed
- **Zero-IPC Playback Failure**: Resolved a critical protocol mismatch where the extension host failed to provide the mandatory `cacheKey` during Zero-IPC signals and extension cache hits.
- **Protocol Enrichment**: Unified the `AudioBridge` event layer to mandate positional context across all playback and error emissions.

## [1.2.5] - 2026-03-31

### Added
- **Predictive Synthesis Prefetching**: Implemented a high-performance "look-ahead" architecture with a depth of 5 sentences and a 200ms debounce to ensure zero-gap sentence transitions.
- **Stall-Guard Logic**: Introduced intelligent prefetch suspension that pauses background tasks if the engine is currently buffering the active sentence, preventing resource starvation.
- **Cache-Warming Telemetry**: Integrated explicit `[CACHE HIT]` and `[CACHE MISS]` tracking in the `PlaybackEngine` to monitor look-ahead effectiveness.

### Changed
- **Passive UI Refactoring**: Eliminated the "Snapback" flicker by making the dashboard purely reactive to the Single Source of Truth via `UI_SYNC` packets.
- **Transactional Synthesis**: Implemented an `activeRequestId` nonce system in `AudioBridge` to resolve "Ghost Audio" by discarding stale synthesis results during rapid navigation.

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
