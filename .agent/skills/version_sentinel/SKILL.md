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

## 5. Prestige Audit Protocol
**MANDATORY**: Before finalyzing any MINOR or MAJOR release, the agent MUST perform a Prestige Audit:
1. **Identify Anchor**: Run the audit tool to find the commit where the current version was set.
2. **Impact Analysis**: Analyze the `git diff --stat` to identify high-impact files (e.g., +4,400 line test expansions).
    - **Exclusion Rule**: Exclude `.agent/` changes from the `CHANGELOG.md`. These are internal-only.
    - **Automation**: The audit tool excludes `.agent/` by default. Use `--include-meta` for full infrastructure visibility. Use `--help` for a complete list of analysis flags.
3. **Deep Audit**: Use `--diff --file [path]` to see the actual implementation of key features.
4. **Representative Summary**: Synthesize a changelog entry that explains *architectural shifts* (e.g. "Intent Sovereignty") rather than just listing commit titles.

## 6. Changelog Protocol
- **Format**: Follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
- **Staging**: Maintain an `## [Unreleased]` section.
- **Finalization**: Handled automatically by the bumping script.
