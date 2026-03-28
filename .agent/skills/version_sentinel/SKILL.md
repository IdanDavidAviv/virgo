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
2. Propose a new version based on SemVer 2.0.0.

## 3. Semantic Rules
- **MAJOR (x.0.0)**: Breaking changes in the bridge protocol, synthesis engine API, or essential user data structure.
- **MINOR (0.x.0)**: New UI features (e.g., voice support, new controls), new navigation logic, or significant performance optimizations.
- **PATCH (0.0.x)**: UI adjustments, CSS fixes, minor dependency updates, and bug fixes that do not change behavior.

## 4. Changelog Protocol
- **Format**: Follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
- **Staging**: While a feature is in development, maintain an `## [Unreleased]` section.
- **Finalization**: When ready for marketplace packaging, move `## [Unreleased]` content to a new version header with the current date.

## 5. Verification Gate
- **ALWAYS** run the local verification script before committing a version bump:
  `node .agent/skills/version_sentinel/scripts/verify_version.js`
