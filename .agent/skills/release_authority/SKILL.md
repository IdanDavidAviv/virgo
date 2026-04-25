---
name: release_authority
description: >
  Unified Release Authority — Single Source of Truth for all release lifecycle actions.
  Merges release_prestige and version_sentinel into one sovereign skill covering:
  semantic versioning rules, authorization gates, pipeline execution, artifact verification,
  git history auditing, SemVer enforcement, and post-release validation.
---

# 🏛️ Release Authority

> **Single Source of Truth for all release actions.**
> This skill supersedes `release_prestige` and `version_sentinel`.
> When any agent prepares or executes a release, this is the ONLY document to read.

---

## 0. Rationale

Releases are the most irreversible action in the development cycle. A version bump cannot
be undone cleanly once pushed. This skill enforces a strict, deterministic chain —
**Audit → Authorize → Gate → Bump → Package → Verify → Push** — ensuring every release
is traceable, tested, and intentional.

---

## 1. Semantic Versioning Rules

Before any release, classify the change:

| Type | Pattern | When to use |
|---|---|---|
| **MAJOR** `x.0.0` | Breaking change | Bridge protocol change, synthesis engine API change, essential user data structure change |
| **MINOR** `0.x.0` | Additive feature | New UI features (voice support, new controls), new navigation logic, significant perf optimization |
| **PATCH** `0.0.x` | Fix / polish | UI adjustments, CSS fixes, minor dependency updates, bug fixes that do not change behavior |

---

## 2. Trigger Logic — When to Act

**MANDATORY**: Before any task involving a feature addition, bug fix, or breaking change:
1. Audit the current version in `package.json`.
2. Ensure `CHANGELOG.md` has a `## [Unreleased]` section primed with the story.
3. Classify the change (MAJOR / MINOR / PATCH).
4. Follow Phase A → Phase B below.

---

## 3. Authorization Gate

> [!CAUTION]
> **ABSOLUTE AUTHORIZATION GATE — NON-NEGOTIABLE**
> The agent is **STRICTLY FORBIDDEN** from executing `npm run release:patch`,
> `release:minor`, `release:major`, or any version-bumping command without an
> **explicit, scoped GO** that directly references the release action.
>
> A "go" or "approve" from a prior discussion about testing, analysis, or an unrelated
> topic is **NOT** authorization to release. The user must say something unambiguous
> like "release it", "run the patch", or "GO for release".
>
> **Violation of this rule is a critical protocol breach.**

---

## 4. Phase A — Audit & Preparation (Mandatory Gate)

Before triggering any automated release:

1. **Full-Spectrum Audit**: Run `npm run release:audit`.
   - Captures unpushed commits, staged changes, and unstaged working directory delta.
   - Identifies the "Representative Story" of the release.
2. **Classify & Dry-Run**: Determine the bump type (MAJOR / MINOR / PATCH).
   - `node .agent/skills/release_authority/scripts/manage_version.js --bump <type> --dry-run`
   - Output shows the exact next version (e.g., `2.6.5`).
3. **Write CHANGELOG Entry** (MANDATORY before any release command):
   - Add `## [x.y.z] - YYYY-MM-DD` at the **top** of `CHANGELOG.md` with real content.
   - No `## [Unreleased]` placeholder — write the dated section directly.
   - `release:changelog-check` will block packaging if the top section is empty.
4. **Authorization Gate**: Review the written entry — wait for explicit GO (§3 above).

> [!CAUTION]
> **DO NOT run any `release:*` command before completing Step 3.**
> `release:changelog-check` enforces this at pipeline level, but the agent must
> write the entry before invoking the pipeline — not after.

---

## 5. Phase B — Execution Pipeline

### 5.1 Automated Workflows

#### Full Pipeline (default — all gates included)

| Command | Action |
|---|---|
| `npm run release:patch` | Full pipeline: gates → bump patch → package |
| `npm run release:minor` | Full pipeline: gates → bump minor → package |
| `npm run release:major` | Full pipeline: gates → bump major → package |
| `npm run release` | Gates + package only (no bump — use when version already set manually) |

#### Fast Pipeline (agent use only — gates already passed this session)

| Command | Action |
|---|---|
| `npm run release:patch:fast` | `release:verify` → bump patch → package (skips lint/typecheck/test/build) |
| `npm run release:minor:fast` | `release:verify` → bump minor → package |
| `npm run release:major:fast` | `release:verify` → bump major → package |

#### GitHub Release (CI-triggered — tag-push model)

| Action | How |
|---|---|
| **Tag-triggered CI** (primary) | Push a `v*.*.*` tag → `.github/workflows/release.yml` builds VSIX in CI, parses CHANGELOG, creates GitHub Release automatically |
| **Local fallback** | `npm run release:github` — reads version + CHANGELOG, creates release + uploads pre-built VSIX. Requires `$env:GITHUB_TOKEN`. |

> [!IMPORTANT]
> **Division of Responsibility:**
> - **Agent writes**: CHANGELOG entry, version bump, commit. Stops here.
> - **Human controls**: `git tag vX.Y.Z && git push origin vX.Y.Z` — this is the release trigger.
> - **CI handles**: Build from source → VSIX → GitHub Release creation → asset upload.
> - **MCP publish** (`npm run publish:mcp`) stays fully manual — protected by npm OTP 2FA.

> [!IMPORTANT]
> **When to use `:fast`:** Only when ALL of the following are true in the **same agent session**:
> 1. `npm run lint` passed explicitly
> 2. `npm run typecheck` passed explicitly
> 3. `npm run test` passed with 100% green
> 4. No files were modified after those runs
>
> **Never use `:fast` as the first action in a session.** `release:verify` still runs to confirm version parity.

### 5.2 Internal Order of Operations

**Full pipeline** (`release:patch`) — agent pre-populates CHANGELOG before running:
```
1. release:quality-gates
   ├─ lint            → ESLint static analysis
   ├─ typecheck       → tsc --noEmit
   ├─ test            → vitest run (100% pass rate required)
   └─ build           → production esbuild bundle
2. release:changelog-check
   └─ manage_version.js --check  → top CHANGELOG section must have ≥1 real bullet
3. manage_version.js --bump patch  → increments package.json version ONLY
4. release:verify  → version_parity(package.json == top CHANGELOG entry)
5. release:package
   ├─ vsce package    → generates .vsix artifact
   └─ verify_artifact.js → confirms .vsix exists + non-zero size
```

**Fast pipeline** (`release:patch:fast`) — agent session only, gates already passed:
```
1. release:changelog-check  → top CHANGELOG section must have content
2. manage_version.js --bump patch  → package.json only
3. release:verify  → parity check
4. release:package
```

**No-bump pipeline** (`release`) — version already set manually:
```
1. release:gates
   ├─ release:verify  → parity check
   └─ release:quality-gates (lint/typecheck/test/build)
2. release:package
```

### 5.3 Pipeline Failure & Safe Retry

- If failure occurs **during gates** → version is NOT bumped. Fix issue, re-run `release:patch`.
- If failure occurs **after bump** (during packaging) → version is already bumped. Run `npm run release` (no `:patch`) to resume without double-bump.
- If failure occurs **during push** → commits are local. Run `git push` only.

> [!CAUTION]
> **CHANGELOG PRE-FLIGHT — WRITE THE TARGET VERSION, NOT THE CURRENT ONE.**
>
> `release:patch` bumps `package.json` mid-pipeline (step 3), then immediately verifies that
> the **new** version exists in CHANGELOG (step 4). If the entry is missing, the pipeline fails
> with a version mismatch — and the bump has already happened, making a clean retry impossible.
>
> **Required state before running `npm run release:patch` from `2.8.0`:**
> ```
> package.json  → "version": "2.8.0"   ← current version (not yet bumped)
> CHANGELOG.md  → ## [2.8.1] - YYYY-MM-DD  ← TARGET version (what it will become)
>                    ### Added
>                    - Real content here...
> ```
> **The CHANGELOG entry must describe the version the pipeline is about to create — not the one it's starting from.**
> If you only have a `## [2.8.0]` entry and run `release:patch`, step 4 will fail looking for `## [2.8.1]`.
>
> **Recovery when the bump already fired:**
> 1. Add the missing CHANGELOG entry for the now-current version.
> 2. Run `npm run release` (no-bump pipeline) — skips the bump, goes straight to verify + package.

---

## 6. Script Reference

All scripts live in `.agent/skills/release_authority/scripts/`.

### 6.1 `manage_version.js` — Verify, Bump, Audit

```powershell
# Verify version parity (package.json == CHANGELOG)
node .agent/skills/release_authority/scripts/manage_version.js

# Bump version (major|minor|patch)
node .agent/skills/release_authority/scripts/manage_version.js --bump patch

# Dry run — preview changes without writing
node .agent/skills/release_authority/scripts/manage_version.js --bump patch --dry-run

# Trigger git history audit
node .agent/skills/release_authority/scripts/manage_version.js --audit --diff
```

**Side effects of `--bump`:** Updates `package.json` version only. The CHANGELOG is strictly agent-managed.

### 6.2 `git_history_audit.js` — Release Story Generator

```powershell
# Standard patch audit (anchor = current version)
node .agent/skills/release_authority/scripts/git_history_audit.js

# Deep audit with full diffs
node .agent/skills/release_authority/scripts/git_history_audit.js --diff

# Minor release audit (anchor = X.Y.0 baseline)
node .agent/skills/release_authority/scripts/git_history_audit.js --minor

# Full audit including agent infrastructure changes
node .agent/skills/release_authority/scripts/git_history_audit.js --include-meta

# Custom range
node .agent/skills/release_authority/scripts/git_history_audit.js --anchor=v1.5.0 --target=v1.6.0
```

**Anchor logic:**
- `--patch`: anchors to the commit that set the current version (delta since last patch)
- `--minor`: anchors to `X.Y.0` baseline
- `--major`: anchors to `X.0.0` baseline

### 6.3 `verify_artifact.js` — VSIX Integrity Check

```powershell
node .agent/skills/release_authority/scripts/verify_artifact.js
```

Reads `package.json` version, constructs expected VSIX filename, confirms file exists and
is non-zero bytes. Called automatically by `release:package`. Exit code 0 = valid artifact.

---

## 7. Git Strategy Handoff (MANDATORY)

> [!IMPORTANT]
> The execution pipeline is an unbroken automated chain. If `npm run release:patch`
> exits with code 0, ALL gates are deemed secure and the VSIX is validated.
> The agent **MUST NOT** pause for manual validation. Transition immediately to
> the **Git Commit & Push Protocol**.

**Mandatory Reference**: [git_strategy](../../../../../.gemini/antigravity/knowledge/git_strategy/artifacts/SKILL.md)

All release commits MUST follow the atomic N-Group strategy:
- **Group 1**: Source changes (implementation files + tests)
- **Group 2**: Version files (`CHANGELOG.md` + `package.json`)
- **Group 3**: Infrastructure / skill updates (catch-all)
- `git push` as its own final call.

---

## 8. SemVer Format Law (`vsce` Enforcement)

> [!IMPORTANT]
> `vsce` validates `package.json` version before packaging. Non-compliant strings
> abort with exit code 1.

**Rule:** Version strings MUST follow: `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-<label>`
where `<label>` contains ONLY alphanumeric characters and hyphens. No dots, no underscores.

```
✅  2.3.0           — standard release
✅  2.3.0-rc1       — pre-release candidate
✅  2.3.0-post-war  — non-standard post-release marker

❌  2.3.0.post_war  — dot separator rejected by vsce
❌  2.3.0-post_war  — underscore in label rejected by vsce
```

**Verification before any `npm run package` call:**
```powershell
node -e "const v = require('./package.json').version; console.log(/^\d+\.\d+\.\d+(-[a-z0-9-]+)?$/.test(v) ? '✅ Valid: ' + v : '❌ Invalid: ' + v)"
```

---

## 9. Post-Release Smoke Test (Optional Manual Verification)

*Fallback / manual inspection only. Do not pause automated pipelines for this.*

1. Open VS Code Extensions view.
2. Click "..." → "Install from VSIX..." → select newly generated package.
3. Smoke Test Checklist:
   - [ ] **Activation**: Status Bar shows "Read Aloud"
   - [ ] **Dashboard**: Glassmorphism UI renders correctly
   - [ ] **Playback**: `Alt+R` works on a valid Markdown file
   - [ ] **Constraint**: "LOAD FILE" button disabled for non-markdown types
   - [ ] **MCP**: `say_this_loud` returns < 1s, sidebar shows snippet, audio plays
