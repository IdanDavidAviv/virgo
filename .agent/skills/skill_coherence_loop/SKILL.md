---
name: skill_coherence_loop
description: Bidirectional protocol for keeping system skills alive. Governs when to read skills as context (planning), when to update them (post-action), and how to audit them for drift (session end).
---

# Skill Coherence Loop

> [!IMPORTANT]
> This skill governs all other skills. Every significant agent action has two mandatory obligations:
> - **READ**: Before acting on a subsystem, identify and read the skill(s) that govern it.
> - **WRITE**: After acting, emit a Skill Harvest table and await user approval before editing any skill.
>
> Neither phase is optional for architectural or behavioral changes.

---

## 1. The Bidirectional Contract

Skills are not static references. They are **living DNA** — the SSOT for how this system's subsystems work. The contract is:

```
User Request
  → skill_coherence_loop: route to relevant skills
  → READ relevant skills as planning context
  → Execute action
  → skill_coherence_loop: harvest findings from action
  → Emit Skill Harvest table
  → ← USER approves
  → Surgical skill edits committed
```

---

## 2. Manual Trigger — `skill pass`

The canonical invocation to explicitly run a coherence pass. Say:

| Invocation | What It Does |
|---|---|
| `skill pass` | Full audit across all system skills listed in the Skill Index |
| `skill pass on diagnostics.log` | Routes log findings → routing map → harvest table |
| `skill pass on Issue #N [description]` | Deep-dives that issue → identifies affected skills → harvest |
| `skill pass on Law X.Y` | Checks which skills should document that Law → spots gaps |
| `skill pass on [feature name]` | Uses the current implementation plan as context |
| `skill pass on startup` | Scopes audit to startup-related skills only |

### Execution Steps for `skill pass [on <context>]`

1. **Identify** the artifact or context provided
2. **Read** each skill in the routing map that applies to that context
3. **Analyze** the context against each skill's current content
4. **Emit** the Skill Harvest table (§ 5)
5. **Gate** — await user approval before touching any skill file

---

## 3. Automatic Flags — Passive Detectors

The agent watches for these signals during any turn. When triggered, a **⚑ Skill Flag** is appended as a one-liner at the end of the response. The agent NEVER auto-edits skills — it only surfaces the flag.

### Flag Format
```
⚑ Skill flag: [skill-name] may need updating — say 'skill pass on [context]' to proceed.
```

### Detector A — Law or Guard Named in Code
**Signal**: A comment matching `// Law X.Y:` or `// Guard:` appears in a new or modified file.
**Action**: Flag the skill that governs that subsystem.
**Example**: `// Law 8.1 (Neural Guard)` → flag `autoplay_orchestration`

### Detector B — Implementation Plan Executed (POST-GO)
**Signal**: User has said GO and the agent has completed plan execution.
**Action**: Auto-generate the Skill Harvest table based on the plan's changed subsystems. Emit as part of the execution summary.
**Note**: This is the strongest trigger — always produces a harvest table, not just a flag.

### Detector C — `diagnostics.log` Analyzed
**Signal**: A `diagnostics.log` file is provided as context AND the agent categorizes issues from it.
**Action**: Auto-build the issue-to-skill routing table as part of the analysis response.
**Example**: Issue #3 (cache count always 0) → flag `state_coherence_v4` and `system_context`

### Detector D — New IPC Message Type or State Field Added
**Signal**: A new `MessageType` enum value, top-level store field, or architectural boundary is introduced in source.
**Action**: Flag `system_context` Skill Index as potentially stale.

### Detector E — Planning Mode Entry
**Signal**: Agent begins writing an `implementation_plan.md`.
**Action**: Agent silently reads all relevant skills as context before formulating the plan. No notification to user — this is the invisible READ phase.

### Detector F — Session Summary Requested
**Signal**: User says "summarize", "wrap up", "end session", "prepare handoff", or similar.
**Action**: Auto-run the full **Skill Coherence Audit** (§ 6). Always produces a Skill Delta Report. Always gates on user approval before edits.

---

## 4. Skill Routing Map

Maps a finding's domain to the primary skill that should document it.

| Finding Domain | Primary Skill | Secondary Skill |
|---|---|---|
| Neural warm-up / re-init / cold-start | `startup_orchestration` | `system_context` |
| Pre-fetch races / lock contention / segment abort | `autoplay_orchestration` | — |
| Cache miss / manifest divergence / count=0 bug | `state_coherence_v4` | `system_context` |
| Dedup guards / synthesisStarting / intentId | `read_aloud_injection_guard` | `state_coherence_v4` |
| IPC flooding / UI_SYNC storms / voice list size | `state_auditor` | `system_context` |
| Playback laws / new guards baked in source | `autoplay_orchestration` | — |
| Rate / pitch / audio corruption | `autoplay_orchestration` | — |
| DPG / Pulse logic / boot sequence | `startup_orchestration` | — |
| Log patterns / shorthand / density | `log_sanitization_v3` | — |
| Engine mode switching (neural/local) | `system_context` | `autoplay_orchestration` |
| Session/turn metadata / extension_state.json | `session_persistence` | — |
| Memory leaks / listener accumulation | `lifecycle_guard` | — |
| Release / packaging / changelog | `release_prestige` | `version_sentinel` |
| New subsystem / renamed file / architectural map change | `system_context` | — |

---

## 5. Post-Action Harvest Gate (Mandatory Format)

After any triggering action, emit this table. Do NOT edit skills until user approves.

```markdown
## 🔬 Skill Harvest
| Skill | Trigger | Update Type | Summary of Change |
|---|---|---|---|
| startup_orchestration | Pulse 2 fires twice | ADD | DPG idempotency guard — fired flag must survive focused_updated events |
| autoplay_orchestration | Segment Aborted on pre-fetch | AMEND | Window=5 causes lock starvation in neural pipe |
| system_context | Cache count always 0 | ADD | Bridge manifest divergence: isFullSync not updating extension host |
```

### Update Taxonomy

| Type | Meaning |
|---|---|
| **ADD** | New subsection: newly discovered pattern, law, or root-cause |
| **AMEND** | Correct an existing section that is now stale or wrong |
| **REFERENCE** | Insert cross-link to another skill or Law (no new content) |
| **STAMP** | Mark a section as superseded or deprecated |

---

## 6. Session-End Skill Coherence Audit

Runs automatically when a session summary is triggered (Detector F).

### Step 1: Scan All Skills
Read every skill listed in `system_context § 0.1 Skill Index`.

### Step 2: Staleness Check Per Skill
For each skill, check:
- [ ] Does it reference files that have been renamed or deleted?
- [ ] Does it describe a pattern superseded by a new Law added this session?
- [ ] Is it missing a cross-reference to a new architectural truth in `system_context`?
- [ ] Is its snapshot date stale (> 2 major versions behind)?

### Step 3: Emit Skill Delta Report

```markdown
## 📊 Skill Delta Report

| Skill | Status | Notes |
|---|---|---|
| autoplay_orchestration | 🔴 Stale | Missing: Law 8.1 Neural Guard |
| startup_orchestration | 🟡 Gap | Missing: Pulse 2 double-fire pattern |
| state_coherence_v4 | 🟢 Healthy | Accurate |
| system_context | 🟡 Gap | Skill Index missing skill_coherence_loop |
```

### Step 4: Positive Progress Summary
Based on Laws added, bugs fixed, and tests added this session, narrate what improved.
This is the **session heartbeat** — a human-readable note about what the system knows now that it didn't before.

**Format**:
```markdown
## ✅ Session Progress (Skill Lens)

This session extended the system's understanding in [N] ways:
- **Law 8.1 (Neural Guard)**: The system now knows that neural audio is pre-baked at the target rate.
  Applying `playbackRate` on top was causing 2x–16x effective speed. This is now guarded.
- **Gate 5 Addendum**: The SyncManager now suppresses state-equivalent flushes during active playback,
  eliminating ~8 redundant 150KB IPC packets per 4-second window.
```

### Step 5: Gate
Present the Delta Report and Progress Summary. Await **GO** before editing any skill.

---

## 7. Skill Staleness Heuristics

A skill section is **stale** if any of the following are true:
- It references a file that no longer exists or was renamed
- It describes a pattern superseded by a named Law added in source
- Its snapshot date is > 2 major versions behind current
- It omits a confirmed architectural truth already present in `system_context`
- A test was added this session that encodes a behavioral invariant not yet documented
