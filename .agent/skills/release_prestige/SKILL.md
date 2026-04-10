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
2.  **Quality Gates**:
    | Step | Gate | Command | v2.4.0 Requirement |
    | :--- | :--- | :--- | :--- |
    | 2.1 | Linting | `npm run lint` | Ensures static analysis parity (Restored: .eslintrc.json) |
    | 2.2 | Type Safety | `tsc --noEmit` | Resolves `executeCommand().catch` Thenable regressions |
    | 2.3 | Build Integrity | `npm run build` | Verifies `dist/mcp-standalone.mjs` artifact generation |
    | 2.4 | Test Suite | `npm run test` | 100% pass rate for unit and bridge tests |
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

---

## 5. Packaging Law — `vsce` SemVer Enforcement (observed: 2026-04-10)

> [!IMPORTANT]
> `vsce` enforces strict SemVer. Non-compliant version strings abort packaging with exit code 1.

**Problem:** When marking a build as a non-standard artifact (e.g., post-war, hotfix, experimental), version strings with **dot-separated** suffixes are rejected by `vsce`:

```
ERROR  Invalid extension "version": "2.2.2.post_war"
ERROR  Invalid extension "version": "2.2.2-post_war"  ← underscore also rejected
```

**Law:** All pre-release version labels MUST use a **hyphen** as the separator and MUST contain only alphanumeric characters (no underscores):

```json
// ✅ VALID — vsce accepts hyphen-separated alphanumeric pre-release labels:
"version": "2.2.2-post-war"
"version": "2.3.0-rc1"
"version": "2.3.0-beta"

// ❌ INVALID — dot or underscore suffix causes exit code 1:
"version": "2.2.2.post_war"
"version": "2.2.2-post_war"
```

**Rule:** Before calling `npm run package`, always verify `package.json` version matches the pattern `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-<alphanumeric-hyphen-label>`.
