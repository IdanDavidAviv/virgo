---
name: release_prestige
description: Protocol for high-integrity extension packaging and installation testing.
---

# 🏆 Release Prestige Protocol

## 0. Rationale
To ensure the ".vsix" file is always production-ready and free of regressions. This protocol mandates a strict "Quality Gate" check before any artifact is generated for distribution.

## 1. Primary Workflows

### 1.1 Integrity Audit (Phase 1)
**MANDATORY**: Before running `npm run package`, the following checks MUST pass:
1.  **Version Sentinel**: Invoke `version_sentinel` to verify `package.json` version matches `CHANGELOG.md`.
2.  **Linting**: Run `npm run lint` to ensure zero stylistic or syntax regressions.
3.  **Production Compile**: Run `npm run build` to generate the final `dist/` bundle (via `esbuild --mode=production`).

### 1.2 Artifact Generation (Phase 2)
1.  **Command**: `npm run package`
    -   This invokes `scripts/package.js`, which handles `vsce package` and legacy artifact cleanup.
2.  **Post-Audit**: Verify the existence of `{project}-{version}.vsix` in the root directory.

### 1.3 Installation Sandbox (Phase 3)
To verify the installation experience, perform the following manual checks:
1.  **Clean Installation**: 
    -   Open VS Code Extensions view.
    -   Click "..." (Views and More Actions) -> "Install from VSIX...".
    -   Select the newly generated package.
2.  **Smoke Test Checklist**:
    -   [ ] **Activation**: Does "Read Aloud" appear in the Status Bar?
    -   [ ] **Dashboard**: Does the Audio Engine webview open and display correctly?
    -   [ ] **Playback**: Does `Alt+R` (Play) work on a Markdown file?
    -   [ ] **Stop**: Does `Alt+S` (Stop) terminate playback and clean up memory?

## 2. Release Integrity Script
Invoke the following to verify the final package:
`node .agent/skills/release_prestige/scripts/verify_artifact.js`
