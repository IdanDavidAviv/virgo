---
name: phonikud_dictionary
description: Protocol for managing custom pronunciations and G2P dictionary overrides in the Virgo local TTS backend.
---

# Phonikud Dictionary Customization Skill

This skill governs the structure and lifecycle of the custom G2P pronunciation dictionary for Virgo's local Hebrew/English text-to-speech engine.

## 📁 Dictionary File Locations

The engine loads and merges two JSON dictionaries (with the user/host override dictionary having higher priority):

1. **Shared Template (Version-Controlled)**:
   - Path: [phonikud_backend/phonikud_dictionary.json](file:///c:/Users/Idan4/Desktop/virgo/phonikud_backend/phonikud_dictionary.json)
   - Purpose: Codebase-level default overrides (seeding template).

2. **User Override Dictionary (Persistent & Local - Primary SSOT)**:
   - Path: [phonikud_dictionary.json (Persistent Override)](file:///C:/Users/Idan4/.gemini/antigravity-ide/virgo/phonikud_dictionary.json)
   - Purpose: The active, customizable pronunciation dictionary loaded by the engine. Auto-initialized as an empty JSON file (`{}`) if missing.

---

## 📝 JSON Dictionary Schema

The dictionary maps lowercase English words to their Hebrew-friendly IPA phoneme representations:

```json
{
  "react": "ʁi\u0294akt",
  "vite": "vajt"
}
```

### Key Phoneme Character Guide (Hebrew Piper Voice)
- `ʁ` (voiced uvular fricative) -> Resh (`ר`)
- `ɡ` (voiced velar plosive) -> Gimel (`ג`)
- `ʃ` (voiceless postalveolar fricative) -> Shin (`ש`)
- `ʒ` (voiced postalveolar fricative) -> Zhein (`ז'`)
- `tʃ` (voiceless postalveolar affricate) -> Tsadi/Tch (`צ'`)
- `dʒ` (voiced postalveolar affricate) -> Gimel/Dj (`ג'`)
- `ʔ` (glottal stop) -> Alef (`א` / `ע`) - used to open up vowels and separate adjacent syllables.
- `ɔ` (open-O) -> Cholam (`וֹ`) - used to make short-O sounds (like stop, Docker) sound open and correct.

---

## 🤖 AI Agent Workflow

When the user corrects a word's pronunciation or asks to add a custom word:

1. **Locate the User Override Dictionary**:
   - The file is located at: [phonikud_dictionary.json](file:///C:/Users/Idan4/.gemini/antigravity-ide/virgo/phonikud_dictionary.json)
2. **Retrieve current overrides**: Call `view_file` on the private override dictionary to see existing entries.
3. **Translate to IPA**: Formulate the phonetic representation of the corrected word using the guide above.
4. **Edit the Override Dictionary Directly**:
   - Use `replace_file_content` to add, update, or remove entries in the user override dictionary [phonikud_dictionary.json](file:///C:/Users/Idan4/.gemini/antigravity-ide/virgo/phonikud_dictionary.json).
5. **DO NOT print the dictionary contents in chat**: Proactively show only a clickable Markdown link to the file: `[phonikud_dictionary.json](file:///C:/Users/Idan4/.gemini/antigravity-ide/virgo/phonikud_dictionary.json)`, instructing the user to click and read it.
6. **Validate**: Run the diagnostic test script `uv run phonikud_backend/diagnostic_test.py` to confirm the synthesis works and sounds correct.

---

## ⚠️ Known Model Limitations & Acoustic Constraints

The underlying Hebrew Piper TTS voice model ("Shaul") has physical/acoustic training limitations that prevent certain sounds from being synthesized natively. Use the following guide to understand these constraints, how to proceed with workarounds, and what updates to wait for from upstream model training:

### 1. The "j" (Gimel-Geresh / ג') Sound Limitation
- **The Issue**: Although `dʒ` is mapped in G2P, the model has **no acoustic weights** trained for `ʒ` or `dʒ`. When these characters appear in the middle of a word (especially after a voiced consonant like `n` in `engine`), the model "swallows" the fricative part and outputs a plain `d` (or `t` after `n`, sounding like "anten" / אנטן).
- **Our Workaround**: Use the voiceless counterpart **`tʃ` (ch / צ')** (e.g. `"engine": "ʔentʃˈen"` -> "אנטש'ן"). Because `tʃ` is natively trained in the Hebrew model (from loanwords like "צ'יפס"), it has strong acoustic weights and sounds clean and sharp, which is the closest possible approximation.
- **Future Resolution**: Wait for the model creators (`thewh1teagle/phonikud`) to train the Piper Hebrew model on a voice dataset containing rich phonetic samples of Zhein-Geresh (`ז'`) and Gimel-Geresh (`ג'`) inside words, assigning them distinct phoneme weights.

### 2. The "w" (Double Vav / וו) Sound Limitation
- **The Issue**: In standard Hebrew G2P, the letter Vav (`ו`) is mapped only to `v` (Vav/Vet), `u` (Shuruk), or `o` (Holam). Thus, the model **has no acoustic representation for /w/**. Passing `w` to the model results in a hard `v` sound (so "middleware" naturally sounds like "midel-ver" / מידלוור).
- **Our Workaround**: Accept the standard Israeli `v` pronunciation (e.g. `"middleware": "midelvˈeʁ"`), or use `u` + `e` if a slower, vowel-hiatus transition ("oo-er") is acceptable. Do not attempt complex IPA combinations of `w` or `u` as they will sound distorted.
- **Future Resolution**: Wait for a future version of the model trained with bilingual (Hebrew-English) data where the English `/w/` phoneme is mapped to a distinct acoustic sound, rather than collapsing into `v`.
