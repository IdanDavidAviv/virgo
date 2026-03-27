# Production Readiness Audit & Roadmap

Based on the current state of the **Readme Preview Read Aloud** extension, here is the roadmap to V1.0.0 (Production).

## 1. Core Stability: Transition to AST Parsing (DONE)
The current regex-based document parsing is brittle and fails on complex Markdown (nested lists, code blocks, etc.).
- **Missing**: Proper integration of `markdown-it`.
- **Action**: Migrate `documentParser.ts` to use an AST parser. This allows for "pixel-perfect" mapping where every sentence knows its exact character offset in the source file.

## 2. Portability: Cross-Platform Parity
The local voice fallback is currently specific to Windows (using PowerShell).
- **Missing**: macOS (`say`) and Linux (`espeak`) implementations.
- **Action**: Create a `LocalVoiceProvider` strategy that detects the OS and selects the appropriate native TTS binary.

## 3. Observability: Proactive Telemetry (DONE)
There is currently no way to know if users are experiencing synthesis failures in the wild.
- **Missing**: A telemetry client.
- **Action**: Implement a privacy-first telemetry module to track `synthesis_error`, `voice_selection`, and `active_sessions`. This is critical for post-launch maintenance.

## 4. Resource Hygiene: Memory Management
Long reading sessions currently accumulate Base64 strings in the webview.
- **Missing**: Audio Blob revocation.
- **Action**: Switch the dashboard to use `Blob` URLs and call `URL.revokeObjectURL()` after each segment plays to keep the footprint low.

## 5. Deployment Packaging
The extension needs to be optimized for the VS Code Marketplace.
- **Missing**: A minified bundle.
- **Action**: Add `esbuild` to the project to bundle the extension host logic and the dashboard assets into a single clean package, reducing activation time.

---

### Implementation Plan Summary

- [x] **Phase 1**: Robust Parsing (Migrate to `markdown-it`).
- [ ] **Phase 2**: Global Reach (Mac/Linux fallback).
- [x] **Phase 3**: Diagnostics (Telemetry integration).
- [ ] **Phase 4**: Efficiency (Blob revocation & Bundling).
