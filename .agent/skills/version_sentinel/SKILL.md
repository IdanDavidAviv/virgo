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
**MANDATORY**: Follow the [Release Prestige](../release_prestige/SKILL.md) protocol for all release audits and packaging. This is the Single Source of Truth for the release chain.

## 6. Changelog Protocol
- **Format**: Follow [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
- **Staging**: Maintain an `## [Unreleased]` section.
- **Finalization**: Handled automatically by the bumping script.

---

## 7. `vsce` Version Format Enforcement (observed: 2026-04-10)

> [!IMPORTANT]
> `vsce` validates `package.json` version before packaging. Non-compliant strings abort with exit code 1.

**Rule:** Version strings MUST follow SemVer: `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-<label>` where `<label>` contains only alphanumeric characters and hyphens (NO dots, NO underscores).

```
✅  2.3.0          — standard release
✅  2.3.0-rc1      — pre-release candidate
✅  2.3.0-post-war — non-standard post-release marker

❌  2.3.0.post_war — dot separator rejected
❌  2.3.0-post_war — underscore in label rejected
```

**Verification:** Before any `npm run package` call, run:
```powershell
node -e "const v = require('./package.json').version; console.log(/^\d+\.\d+\.\d+(-[a-z0-9-]+)?$/.test(v) ? '✅ Valid: ' + v : '❌ Invalid: ' + v)"
```

See also: [release_prestige §5](../release_prestige/SKILL.md#5-packaging-law--vsce-semver-enforcement-observed-2026-04-10)

