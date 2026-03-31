---
name: release_prestige
description: Protocol for high-integrity extension packaging and installation testing.
---

# 🏆 Release Prestige Protocol

## 0. Rationale
To ensure the ".vsix" file is always production-ready and free of regressions. This protocol mandates a strict "Quality Gate" check before any artifact is generated for distribution.

## 1. Primary Workflows (One-Click Release)

### 1.1 Automated Pipeline
**MANDATORY**: Use the scripted release commands in `package.json` to handle the entire lifecycle.

1.  **Patch Release**: `npm run release:patch`
2.  **Minor Release**: `npm run release:minor`
3.  **Major Release**: `npm run release:major`

### 1.2 Execution Sequence (Internal)
The orchestrated command performs the following in a single transaction:
1.  **Version Sentinel**: Bumps version, renames `[Unreleased]` changelog section, adds date.
2.  **Linting**: Runs `npm run lint`.
3.  **Production Compile**: Runs `npm run build` (esbuild production mode).
4.  **Packaging**: Runs `npm run package` (vsce + cleanup).
5.  **Audit**: Runs `verify_artifact.js` to ensure zero corruptions.

## 2. Manual Verification Sandbox
To verify the installation experience, perform the following manual checks:
1.  **Clean Installation**: 
    -   Open VS Code Extensions view.
    -   Click "..." (Views and More Actions) -> "Install from VSIX...".
    -   Select the newly generated package.
2.  **Smoke Test Checklist**:
    -   [ ] **Activation**: Check Status Bar ("Read Aloud").
    -   [ ] **Dashboard**: Ensure Glassmorphism UI is perfectly rendered.
    -   [ ] **Playback**: Test `Alt+R` on a valid Markdown file.
    -   [ ] **Constraint**: Ensure "LOAD FILE" button is disabled for non-markdown types.

## 3. Final Gate
`npm run release` (Run without args to verify an existing version sync).

## 4. Post-Release: Git Strategy
**MANDATORY**: After the artifact is verified by `verify_artifact.js`, the agent **MUST** transition immediately to the **Git Commit & Push Protocol** as defined in the following Knowledge Item:
- **Internal Protocol**: [git_strategy](../../../../../../.gemini/antigravity/knowledge/git_strategy/artifacts/SKILL.md)
- **Direct Reference**: `file:///C:/Users/Idan4/.gemini/antigravity/knowledge/git_strategy/artifacts/SKILL.md`

All release commits (Version Bump, Changelog, and Stable Source) must be grouped and pushed following the atomic N-Group strategy before the task is considered complete.
