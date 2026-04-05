---
name: version_sentinel
description: Protocol for high-integrity semantic versioning and changelog management.
---

# 🛡️ Version Sentinel Skill

## 1. Rationale
To ensure the "Readme Preview Read Aloud" extension maintains a professional, predictable release cycle. This skill prevents version drift where `package.json` and `CHANGELOG.md` become disconnected.

## 2. Trigger Logic
**MANDATORY**: Before any task that involves a feature addition, bug fix, or breaking change, the agent MUST:
1. Audit the current version in `package.json`.
2. Ensure the `CHANGELOG.md` has an `## [Unreleased]` section.
3. Use the automated bumping tool to finalize a release.

## 3. Semantic Rules
- **MAJOR (x.0.0)**: Breaking changes in the bridge protocol, synthesis engine API, or essential user data structure.
- **MINOR (0.x.0)**: New UI features (e.g., voice support, new controls), new navigation logic, or significant performance optimizations.
- **PATCH (0.0.x)**: UI adjustments, CSS fixes, minor dependency updates, and bug fixes that do not change behavior.

## 4. Automated Management Protocol
- **Verification**: `node .agent/skills/version_sentinel/scripts/manage_version.js` (No args)
- **Bumping**: `node .agent/skills/version_sentinel/scripts/manage_version.js --bump [major|minor|patch]`
- **Audit**: `node .agent/skills/version_sentinel/scripts/git_history_audit.js`
- **Side Effects**: Automatically updates `package.json` and injects the current date into the `CHANGELOG.md` while preserving an empty `## [Unreleased]` section for the next cycle.

## 5. Hierarchical Prestige Audit (MANDATORY)
**MANDATORY**: Before finalizing **ANY** release, perform a Hierarchical Audit to ensure full visibility:
1.  **Identify Intent**: Determine it is a `--patch`, `--minor`, or `--major` release.
2.  **Execute Audit**: Run `npm run release:audit -- --[level]`.
3.  **Hierarchical Baselines**:
    *   `--patch`: Anchor is the current version (summarizes work since the last hotfix).
    *   `--minor`: Anchor is the last minor (major.minor.0). Summarizes the entire minor series.
    *   `--major`: Anchor is the last major (major.0.0). Summarizes the entire major series.
4.  **Synthesis**: Create a "Representative Story" excluding agent-specific infrastructure.

## 6. Changelog Protocol
- **Format**: Follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
- **Staging**: Maintain an `## [Unreleased]` section.
- **Finalization**: Handled automatically by the bumping script.
