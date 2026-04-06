# Change Log

All notable changes to the "Readme Preview Read Aloud" extension will be documented in this file.

## [Unreleased]

### Added
- 

## [2.1.1] - 2026-04-06

### Added
- 

## [2.1.1] - 2026-04-06

### Audio Autoplay Resolution
This patch addresses the "NotAllowedError" triggered by modern browser security policies when third-party injections (MCP) attempt to trigger speech synthesis without direct user interaction. 

- **Audio Unlock Shield**: Introduced a premium glassmorphic overlay that informs the user when audio is blocked and provides a seamless, one-click "blessing" trigger.
- **Gesture Propagation**: Enhanced `InteractionManager` to automatically prime the `AudioContext` on any global keypress or click, ensuring that subsequent automated injections are pre-authorized.
- **Fail-Safe Playback**: Refactored `WebviewAudioEngine` to catch and manage browser-enforced blocks, preventing the internal state from hanging during "NotAllowedError" exceptions.

## [2.1.0] - 2026-04-05

### Added


### Sovereign Playback & Hierarchical Audit
This release formalizes the **Prestige Release Protocol** with the introduction of the **Hierarchical Audit**, providing full-spectrum visibility into the extension's architectural trajectory. It also marks the debut of the **Sovereign Playback Engine**, a hardened synchronization layer that eliminates "Ghost Audio" and ensures absolute intent-aware synthesis parity.

#### 1. Hierarchical Audit Protocol
- **Trajectory Discovery**: Enhanced `version_sentinel` with flag-driven auditing (`--patch`, `--minor`, `--major`) to capture deep architectural shifts across release cycles.
- **Surgical Diff Analysis**: Automated the sanitization and grouping of commit deltas for high-context changelog generation.
- **Release Prestige**: Automated the "Burn" pipeline to ensure 100% synchronized versioning across `package.json`, `CHANGELOG.md`, and VSIX metadata.

#### 2. Sovereign Playback (Intent-Aware)
- **Monotonic Intent IDs**: Introduced `playbackIntentId` in `PlaybackEngine` to provide authoritative rejection of stagnant audio buffers from previous navigation intents.
- **Resource-Strict Mapping**: Updated the `WebviewAudioEngine` to bind audio streams strictly to their originating resource URIs, preventing "Zombie" playback across file transitions.
- **Telemetry Hardening**: Added `Number.isFinite` and composite object guards in the `WebviewStore` to prevent state corruption during high-frequency synchronization.

#### 3. MCP Bridge Hardening
- **Turn Manager Architecture**: Refactored `TurnManager` into a high-integrity singleton for centralized turn-index tracking and sequence validation.
- **Protocol Hydration**: Automated the generation of oral and visual turn headers (`# [Turn XXX]`) for virtual document injections via the MCP bridge.
- **Multi-Root Workspace Parity**: Standardized path-agnostic metadata resolution to ensure persistent session history across complex VS Code workspaces.

## [2.0.8] - 2026-04-05

### Added
- **Store Hydration Sovereignty**: Hardened `WebviewStore` against premature asynchronous syncing. UI and Cache updates are now rejected until a fully formed `UI_SYNC` handshake establishes the baseline.
- **Cache Statistical Parity**: Enforced strict `updateState` object alignment so the webview mirrors the exact `{ count, size }` composite data structures sent by the extension.
- **Control System Audit**: Stabilized the `control_system_audit` tests by enforcing proper asynchronous dispatching and accurate backend object modeling.

### Fixed
- **Neural Buffer Ghost Wipe**: Resolved a test-environment regression in `NeuralCache.test.ts` where delayed promise resolution from async memory wipes (`AudioEngine`) would silently overwrite the state of sibling test suites.

## [2.0.7] - 2026-04-05

### Added
- **IPC Protocol Hardening**: Decoupled `availableVoices` from the high-frequency `UI_SYNC` packet, significantly reducing routine synchronization bandwidth.
- **Log Level Parity**: Synchronized `readAloud.logging.level` from the extension host to the webview, enabling consistent diagnostic telemetry across the bridge.
- **Shorthand Log Sanitization**: Implemented payload truncation for massive IPC commands (Voices, Sync) in `Standard` logging mode to eliminate console bloat.
- **Turn Sentinel Sovereignty**: Added TDD-backed logic to reject stale or out-of-order text injections in the MCP bridge.
- **Cache Wipe Integrity**: Implemented proactive memory purging and blob URL revocation before cache clearing to prevent audio "ghosting."

### Fixed
- **Sync Signature mismatch**: Resolved a TypeScript lint error in `SpeechProvider.ts` caused by outdated `_syncUI` parameters.

## [2.0.6] - 2026-04-05

### Added
- **Brain-Sensitive Pivoting**: Integrated a `FileSystemWatcher` on the Antigravity root to detect new session directories in real-time and trigger automatic session pivots in the extension.
- **Identity Bootstrapping**: Automated the creation of a default "New session - to be named" title in `state.json` for every new bridge session, ensuring a premium first impression in the sidebar history.
- **Protocol Reinforcement**: Formalized mandatory **Genesis** and **SITREP** text injections to maintain 1:1 parity between agent-led sessions and the portable Read Aloud history.
- **Hardened Release Integrity**: Re-engineered the Prestige Audit to capture uncommitted changes and strictly separated Discovery from Execution in the release pipeline.

### Fixed
- **Invisible Session Bug**: Resolved a critical UI bug where the currently active session would disappear from the "Snippet History" sidebar if it contained zero snippets. Active sessions are now always visible.

## [2.0.5] - 2026-04-05

### Added
- **Critical UI_SYNC Command**: Promoted synchronization to a critical IPC command, ensuring background injections hydrate the webview state even when hidden.
- **Visibility-Aware Sync**: Implemented a "Full Sync" trigger for the sidepanel to immediately re-hydrate snippet history upon sidebar reveal.
- **Verbatim Parity Protocol**: Standardized 1:1 parity between conversational summaries and auditory injections for high-integrity vocal sync.

### Fixed
- **Snippet UI Latency**: Resolved an issue where snippet history would only update after a manual toggle or playback event.

## [2.0.4] - 2026-04-05

### Added
- **Humanized Session Titles**: Refactored the "Snippet History" sidebar to resolve and display human-readable session names instead of UUIDs.
- **Local Metadata Persistence**: Migrated session `state.json` storage from core agent directories to the extension-local `read_aloud` data store for absolute architectural decoupling.
- **MCP Title Injection**: Updated Antigravity MCP servers to accept and persist an optional `session_title` parameter, allowing for seamless narrative context during text injection.
- **Premium Glassmorphism**: Enhanced the `SnippetLookup` component with vibrant background blurs and optimized list haptics.
- **Automated Metadata Migration**: Implemented a transition layer to bulk-migrate historical session titles to the new local persistence model.

### Fixed
- **UI State Flickering**: Resolved a race condition where snippet titles would momentarily reset to UUIDs during high-frequency synchronization events.

## [2.0.3] - 2026-04-04

### Vocal Sync & UI Persistence
This release formalizes the **Vocal Sync Protocol** by automating turn-index management in the MCP bridge and standalone servers. It also resolves a critical UI bug where the snippet history list would flicker or disappear during high-frequency playback updates.

#### 1. Automated Turn Management
- **Persistent Indexing**: Implemented an atomic turn-state tracking mechanism per session using a local `state.json` store.
- **Turn Index Feedback**: New injections now automatically prepend a `# [Turn XXX]` header to the markdown content, providing oral and visual serialization context.
- **Session-Aware Watcher**: Refactored the Antigravity root watcher to handle automated session-id pivoting and conditional auto-play based on user settings.

#### 2. UI Synchronization & Stability
- **Sync Guardian Protocol**: Hardened `WebviewStore.ts` delta-sync logic to preserve `snippetHistory` and `activeSessionId` during partial state updates.
- **Improved Performance**: Refactored `SnippetLookup` to use stabilized history arrays, reducing redundant renders and layout shifts.
- **Autoplay Control**: Exposed `playback.autoPlayOnInjection` in settings to allow user-controlled immediate playback of tool-injected content.

## [2.0.2] - 2026-04-04

### Stable Sovereignty & Navigation
This release addresses critical UI state regressions by implementing the **Mode Sovereignty Protocol**. By establishing a 500ms immunity window on the `activeMode` intent, the extension now reliably protects user navigation from stale `UI_SYNC` packets during heavy document parsing. Additionally, the Antigravity navigation has been refactored into a high-density, 2nd-layer drill-down system with reactive "Premium Glow" indicators to ensure seamless visual parity between file and snippet sources.

## [2.0.1] - 2026-04-04

### Antigravity Bridge Genesis
- **Antigravity Stream Protocol**: Establishing the `ReadAloud-Bridge`, allowing external AI agents to stream and inject Markdown content directly into the neural synthesis pipeline.
- **Virtual Document Sovereignty**: Implemented atomic `activeMode` transitions ('FILE' vs 'SNIPPET') to ensure the webview dashboard correctly hydrates and tracks virtual content injected via the MCP bridge.
- **Persistent Injection Store**: Integrated a file-backed persistence layer for external snippets, ensuring that injected AI content survives VS Code session restarts with full navigation parity.

## [2.0.0] - 2026-04-04

### Major System Re-architecture
This release marks the baseline transition to a modernized, reactive architecture designed for scalability and reduced latency. The system has been restructured into a domain-driven model to ensure strict separation of concerns and improved maintainability.

#### Domain-Driven Architecture Implementation
- **Structural Decoupling**: Segregated the monolithic legacy extension logic into distinct `@core` (business logic), `@vscode` (host integration), and `@webview` (interface layer) domains.
- **Reactive State Management**: Implementation of a centralized `WebviewStore` based on a predictable state container pattern to eliminate synchronization errors common in the legacy monolithic bridge.
- **Enhanced Inter-Process Communication (IPC)**: Standardized messaging using an enum-driven `MessageClient` bridge, improving the reliability of commands between the extension host and the webview renderer.

#### Neural Synthesis and Performance Optimizations
- **Direct Variable-Length Audio Distribution**: Optimized binary transmission to push audio data directly into the webview's internal cache, reducing the overhead associated with redundant IPC handshakes.
- **Predictive Prefetching Engine**: Integrated an asynchronous look-ahead processor with a five-sentence circular buffer to provide continuous playback and eliminate gaps between segments.
- **State Sovereignty and Synchronization Guardians**: Introduced isolation windows and synchronization watchdogs (3.5s and 4.0s timeout thresholds) to resolve race conditions and recycle stalled synthesis threads.

#### Componentized Interface and User Experience
- **Functional Component Migration**: Extracted all dashboard UI logic into isolated, reactive ESM modules for improved lifecycle management.
- **Integrated Voice Discovery**: Implemented a filtered voice selection mechanism with real-time feedback and support for specialized high-fidelity neural voices.
- **Context-Aware Document Parsing**: Added specialized processing for technical artifacts, including markdown code blocks (with language metadata detection) and statistical summaries for tabular data.

#### Quality Engineering and Verification
- **Automated Regression Suite**: Expanded test coverage (+4,400 lines) with a high-integrity verification pipeline, achieving full pass rates across 250 test cases.
- **Deterministic State Persistence**: Migrated configuration state to the standard `settings.json` format and implemented MD5-based content hashing to track reading progress across file modifications.

---

## [1.6.4] - 2026-04-04

### Added
- **Delta Sync Protocol**: Introduced partial state synchronization to optimize IPC bandwidth; moved `availableVoices` to an explicit handshake phase.
- **Throttled Synchronization**: Implemented 50ms sync-throttling in `SpeechProvider` to prevent command saturation.
- **Haptic Prefetch Alignment**: Synchronized `AudioBridge` look-ahead logic with the new 200ms debounce architecture.

### Fixed
- **Test Suite Isolation**: Eliminated non-deterministic regressions in `audioBridge` and `RaceCondition` tests via strict `afterEach` cleanup protocols.
- **TypeScript Type Integrity**: Resolved "unknown" type diagnostic errors in the voice discovery integration tests.

## [1.6.3] - 2026-04-04

### Added
- **Unified Playback Controller**: Restored `src/webview/playbackController.ts` based on stable `dashboard.js` logic to ensure architectural parity across modern components.
- **Fail-Safe Synchronization**: Implemented a 3.5s "Sync Watchdog" to prevent UI hanging during non-deterministic extension-to-webview handshakes.
- **Atomic Intent Logic**: Standardized `CONTINUE` vs `LOAD_AND_PLAY` actions within the singleton controller for predictable playback transitions.

## [1.6.2] - 2026-04-03

### Added
- **Document Loading Sovereignty**: Implemented a 2000ms "Sovereignty Window" for the `LOAD_DOCUMENT` action to protect the UI from stale synchronization data during heavy parsing.
- **Isolated Loading Feedback**: Redirected "Loading Document..." feedback exclusively to the **Reader (Active File)** slot; the **Focused File** context now remains stable and evidence-based.

### Fixed
- **Stuck Loading Button**: Resolved a UI state bug where the "Load File" button became non-interactive after a single click. Replaced the invasive `.is-loading` spinner with a lightweight `.pulse` gesture and native sync-locking.

## [1.6.1] - 2026-04-03

### Added
- **Intent Sovereignty Guard**: Implemented a 500ms immunity window in `WebviewStore` to prioritize local user intent over stale `UI_SYNC` packets from the Extension Host.

### Fixed
- **Optimistic Loading Slot**: Corrected `FileContext` routing; the "Loading Document..." feedback now correctly appears in the **Reader (Active File)** slot instead of the Focused context.
- **Modularization Finalized**: Fully decommissioned the legacy `dashboard.js` monolith, transitioning all UI logic to reactive ESM components.

### Changed
- **Baseline Parity**: Reverted default `rate` value to `0` to maintain synchronization with the integration test suite.

## [1.6.0] - 2026-04-03

### Added
- **Production-Hardened Reliability (Integration v3)**:
    - Expanded the test suite by **+4,400 lines**, introducing comprehensive E2E and integration-first validation.
    - Implemented a rigid **Singleton Lifecycle Protocol** to eliminate memory leaks and "zombie state" contamination between sessions.
    - Achieved a **100% Pass Rate** (250 tests) across the entire component architecture.
- **Intent Sovereignty Architecture**:
    - Integrated high-performance **Optimistic UI Patching** via `WebviewStore.optimisticPatch`, ensuring zero perceived latency for user actions.
    - Synchronized playback intent (Play/Pause/Stop) with immediate visual feedback, bypassing extension host handshake delays.
- **Elite Visual Haptics**:
    - Integrated a global `.pulse` animation layer for transport buttons.
    - Synchronized `statusDot` engine feedback with real-time user intent.
    - Re-engineered `.is-loading` CSS for mathematically perfect alignment and layout stability during state transitions.

### Fixed
- **Defensive Event Handling**: Resolved runtime crashes in virtual/test environments by standardizing `(e?.currentTarget || element)` guards.
- **UI_SYNC State Regression**: Corrected a critical settings hydration failure in the `WebviewCore` layer.
- **State Cleansing**: Refined `readerSlot` clearing semantics to guarantee a zero-stale-state implementation.

### Changed
- **Webview Infrastructure Refactoring**: Promoted `MessageClient` and `WebviewStore` to high-integrity singletons with authoritative lifecycle hooks.

## [1.5.3] - 2026-04-02

### Added
- **Chapter List "Link-First" Priority**:
    - Re-engineered the chapter navigation to support interactive, style-embedded file links (`[label](file:///...)`) within titles.
    - Implemented an **Event Propagation Guard** that prioritizes file link interactions, preventing unwanted chapter jumps when interacting with document citations.
    - Refined visual hierarchy with mathematical multi-level indentation (H1/H2/H3 depth normalization).
- **Keyboard Navigation Hardware Guard**:
    - Implemented a low-latency (100ms) hardware debounce for all navigation keys (`ArrowUp/Down/Left/Right`).
    - Eliminates extension host command flooding and audio stutter during rapid-repeat key events.
- **Neural SSML Integrity Layer (Issue #36)**:
    - Introduced a centralized XML-safe sanitization protocol in the `speechProcessor.ts` core.
    - Guarantees fail-safe delivery to the Neural TTS engine by automatically escaping ampersands, tag delimiters, and quotes.

## [1.5.2] - 2026-04-02

### Added
- **Premium UI Restoration**:
    - Restored **Glassmorphism** effects and deep transparency to the settings drawer with refined CSS haptics.
    - Implemented a custom, searchable **Voice Selector** with neural voice indicators (✨).
    - Added real-time numeric feedback for speed and volume sliders.
- **Testing Stability Infrastructure**:
    - Introduced explicit `dispose()` protocols for `MessageClient`, `WebviewStore`, and `ToastManager` to guarantee zero memory leakage in test environments.
    - Unified the test runner with a global `vitest.setup.ts` providing authoritative `indexedDB` and `scrollIntoView` mocks for the JSDOM environment.

### Fixed
- **Testing Memory Leaks**: Resolved systemic event listener accumulation and pending timer leaks in the webview components.
- **Audio Defaults**: Enforced safe startup defaults (`rate: 0`, `volume: 50%`) to prevent audio clipping and playback drift.

## [1.5.0] - 2026-04-02

### Added
- **The Great Modularization (Phase 5.4)**: Successfully decommissioned the monolithic `dashboard.js`, extracting all remaining UI logic into strictly-typed, reactive ESM components (`PlaybackControls`, `SettingsDrawer`, `VoiceSelector`, `ToastManager`).
- **Surgical IPC Protocol**: Introduced `WebviewStore.patchState()`, enabling high-performance, incremental UI updates that bypass the overhead of full `UI_SYNC` cycles.
- **Regression Logic Hardening**: Expanded the test suite with specialized validation for `PlaybackControls` (status-dot lifecycle) and `utils.test.ts` (XSS/Link-rendering guards).
- **Log Sanitization v2**: Ported high-density `logSafeMessage` logic to provide truncated, human-readable IPC telemetry while protecting privacy.

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
- **Infrastructure Genesis (Phase 5.3)**: Introduced the early **Reactive State Management** foundation (`WebviewStore`) and the **Resilient IPC Bridge** (`MessageClient`) to eliminate non-deterministic race conditions during dashboard initialization.
- **Atomic Navigation Feedback**: Integrated a "Pending Jump" state in the `SentenceNavigator` component to provide immediate visual confirmation across the webview boundary.

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
- **Smart-Logic Navigation**: 
    - Re-engineered `ArrowUp` to intelligently restart chapter progress vs. jumping back, backed by hardware-level key repeat guards to prevent command flooding.
    - Implemented Unicode-aware suppression of emojis, flags, and skin tone modifiers to ensure clear, distraction-free speech synthesis.

### Fixed
- **Isolation Protocol (Issue #28)**: Resolved a critical navigation leak by enforcing atomic chapter jumps, preventing keyboard overflows from triggering accidental sentence skips.

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
    - **Intent-Ejection Protocol**: Implemented a transactional nonce system (`activeRequestId`) to immediately discard stale synthesis results during rapid navigation, eliminating "Ghost Audio".
    - **Zero-Handshake Ingestion**: Optimized `AudioBridge` to trigger webview cache checks immediately upon navigation.
    - **Concurrent Task Deduping**: Shared task tracking for identical text segments to prevent redundant Azure TTS calls.
- **Neural Stability Watchdog**:
    - **MsEdgeTTS Recycling**: Automated client re-initialization and socket clearing on synthesis timeouts.
    - **Buffering Telemetry**: New `engineStatus: 'buffering'` event for improved UI feedback during network recovery.
- **Atomic UI-Sync**: Hardened synchronization between the extension host and webview state.

## [1.3.2] - 2026-03-31

### Added
- **Content-Aware State (MD5 Integrity)**:
    - **Integrity Fingerprinting**: Introduced automated **MD5 Integrity Fingerprinting** to track document changes, ensuring reading progress accurately resets on file modification.
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
- **Domain-Driven Architecture**: Executed the major decoupling of monolithic extension logic into isolated `@core`, `@vscode`, and `@webview` domains for ultimate architectural stability and predictable path routing.
- **Global Path Aliasing**: Implemented high-integrity `tsconfig.json` mappings to eliminate brittle relative imports across all source files and test suites.

### Changed
- **Asset Centralization Protocol**: Consolidated marketplace branding and animations into a root `/assets` directory to separate production runtime resources from repository metadata.

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
- **Serverless Evolution (Phase 1)**: Fully decommissioned the legacy `BridgeServer` infrastructure, migrating all extension-to-dashboard communication to the native **VS Code postMessage protocol**, eliminating port collisions and installation locks.
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
