---
name: release_prestige
description: Protocol for high-integrity extension packaging and installation testing.
---

# 🏆 Release Prestige Protocol

## 0. Rationale
To ensure the ".vsix" file is always production-ready and free of regressions. This protocol mandates a strict "Quality Gate" check before any artifact is generated for distribution.

## 1. Phase A: Discovery & Preparation (Manual Gate)
Before triggering any automated release, the agent or human **MUST** establish the full spectrum of the current delta to inform the representation story.

1.  **Full-Spectrum Audit**: Run `npm run release:audit`. 
    -   This captures **unpushed commits**, **staged changes**, and **unstaged working directory delta**.
2.  **Contextual Synthesis**: Use the audit output to identify the "Representative Story" of the release.
3.  **Priming**: Manually populate the `## [Unreleased]` section of `CHANGELOG.md` with the identified story.
4.  **The Authorization Gate**: Review the "primed" changelog with the user and wait for an explicit "GO."

## 2. Phase B: Execution Pipeline (Burn)
The execution pipeline is a deterministic process that burns the primed changelog into a versioned record and packages the stable artifact.

### 2.1 Automated Workflows
1.  **Patch Release**: `npm run release:patch`
2.  **Minor Release**: `npm run release:minor`
3.  **Major Release**: `npm run release:major`

### 2.2 Internal Order of Operations (The Orchestrated Chain)
The `npm run release` script is a high-integrity sequence that automates the following chain:
1.  **Consistency Gate**: `npm run release:verify` (ensures 1:1 parity between package and changelog version strings).
2.  **Quality Gates**: `npm run lint`, `npm run typecheck`, and `npm run test` (Ensuring zero static or runtime regressions).
3.  **Production Compile**: `npm run build` (Production mode bundling).
4.  **Packaging**: `npm run package` (vsce artifact generation).
5.  **Prestige Audit**: `verify_artifact.js` (Signature check for VSIX creation).

## 3. Final Gate: Git Strategy (Unbroken Chain)
**MANDATORY**: The execution pipeline is an unbroken automated chain. If the `npm run release:patch` (or minor/major) exits with code 0, all static and runtime gates are deemed secure, and the VSIX is validated. 

The agent **MUST NOT** pause the automated workflow for manual validation. The agent **MUST** transition immediately to the **Git Commit & Push Protocol** as defined in the following high-integrity Knowledge Item:
- **Internal Protocol**: [git_strategy](../../../../../../.gemini/antigravity/knowledge/git_strategy/artifacts/SKILL.md)
- **Direct Reference**: `file:///C:/Users/Idan4/.gemini/antigravity/knowledge/git_strategy/artifacts/SKILL.md`

You **MUST** strictly follow the **gitpush** protocol. All release commits (Version Bump, Changelog, and Stable Source) must be grouped and pushed following the atomic N-Group strategy before the task is considered complete.

## [OPTIONAL] 4. Post-Release: Manual Verification Sandbox
*This is a fallback or manual inspection step only. Do not pause automated pipelines for this.*
To verify the installation experience manually:
1.  **Clean Installation**: 
    -   Open VS Code Extensions view.
    -   Click "..." (Views and More Actions) -> "Install from VSIX...".
    -   Select the newly generated package.
2.  **Smoke Test Checklist**:
    -   [ ] **Activation**: Check Status Bar ("Read Aloud").
    -   [ ] **Dashboard**: Ensure Glassmorphism UI is perfectly rendered.
    -   [ ] **Playback**: Test `Alt+R` on a valid Markdown file.
    -   [ ] **Constraint**: Ensure "LOAD FILE" button is disabled for non-markdown types.
