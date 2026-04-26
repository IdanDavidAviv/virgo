# 🤖 Agent Guided Preferences Skill Definition Protocol

> **SYSTEM DIRECTIVE FOR AI AGENTS:**
> This protocol is meant to be executed IMMEDIATELY after a successful Virgo installation, or whenever the user requests to configure Virgo's behavior.
> Your objective is to proactively guide the user in setting up their personalized preferences for when and how you (the AI) should use the `say_this_loud` tool.
>
> **CRITICAL:** Follow the exact logic paths below. Do NOT skip steps.

---

## Phase 1: Context Analysis & Strategy Formulation

Before addressing the user, analyze your interaction history with them (e.g., from the current chat context or memory logs).
Determine their working style. Do they prefer:
- Long, detailed explanations?
- Short, concise summaries?
- Step-by-step guidance?

Based on this, formulate **three customized strategies** for using Virgo.
*Examples of strategies you might suggest:*
1. **The Narrator:** "I will read aloud every implementation plan and architectural proposal before asking for your approval."
2. **The Executive:** "I will only speak at the end of a major task, giving you a brief SITREP (Situation Report)."
3. **The Pair Programmer:** "I will speak frequently during coding steps, narrating the changes as I make them."

## Phase 2: The Interview

Present the strategies to the user in a friendly, conversational manner.

**Tell the user (in your own words):**
1. Acknowledge the successful installation of Virgo.
2. Explain that to make Virgo truly useful, you need to know *when* they want you to speak.
3. Present the three strategies you formulated in Phase 1.
4. Ask them to pick a strategy, or mix and match elements to create their own.
5. Ask them if they want these preferences saved as a **Global Skill** (applies to all projects on their machine) or a **Local Skill** (specific to the current workspace).

## Phase 3: Skill Generation / Update

Once the user has clarified their preferences, you must save them into a skill file.

1. **Determine the File Path:**
   - **Local Skill:** Create or update `.agent/skills/how_to_virgo/SKILL.md` (or `.cursor/rules/how_to_virgo.md` depending on the IDE).
   - **Global Skill:** Guide the user to place it in their IDE's global rules directory, or save it there directly if you have access.
2. **Write the Skill:**
   The skill file should explicitly instruct *you* (and future instances of you) on exactly when to invoke the `say_this_loud` tool.

**Template for the generated Skill:**
```markdown
# How to Virgo

**Description:** User preferences for when the AI agent should use the `say_this_loud` tool.

## Voice Triggers
*   [Trigger 1: e.g., "Always read implementation plans aloud before asking for a GO."]
*   [Trigger 2: e.g., "Give a 2-sentence vocal summary at the end of every turn."]

## Behavior
*   [e.g., "Keep vocal summaries concise, avoid reading code blocks aloud, focus on high-level strategy."]
```

## Phase 4: Confirmation & Handoff

**Tell the user (in your own words):**
1. Confirm that the skill has been created/updated.
2. Explain that from now on, you will automatically follow these preferences.
3. Test it out! Give them a vocal summary of what you just accomplished using the `say_this_loud` tool, adhering to the newly defined rules.
4. Proceed to the final **Support the Creator** phase in your main install guide.

---
> **END OF SYSTEM DIRECTIVE**
