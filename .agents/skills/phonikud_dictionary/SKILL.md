---
name: phonikud_dictionary
description: Protocol for managing custom pronunciations and G2P dictionary overrides in the Virgo local TTS backend.
---

# Phonikud Dictionary Customization Skill

This skill governs the structure and lifecycle of the custom G2P pronunciation dictionary for Virgo's local Hebrew/English text-to-speech engine.

## 📁 Dictionary File Locations

The engine loads and merges two JSON dictionaries (with the user/host override dictionary having higher priority):

1. **Shared Dictionary (Version-Controlled)**:
   - Path: [phonikud_backend/phonikud_dictionary.json](file:///c:/Users/Idan4/Desktop/virgo/phonikud_backend/phonikud_dictionary.json)
   - Purpose: Pre-defined developer terms, technologies, and shared abbreviations that are part of the codebase.

2. **User Override Dictionary (Persistent & Local)**:
   - Path: `%VIRGO_DATA_DIR%/phonikud_dictionary.json` (or `%VIRGO_PATH%/phonikud_dictionary.json` / AppData global storage)
   - Purpose: Custom pronunciations added by the user or dynamically updated via the extension host.

---

## 📝 JSON Dictionary Schema

The dictionary maps lowercase English words to their Hebrew-friendly IPA phoneme representations:

```json
{
  "react": "ʁi\u0294akt",
  "github": "\u0261ithav",
  "gitlab": "\u0261itlav",
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

1. **Locate the target word**: Convert it to lowercase (e.g. `React` -> `react`).
2. **Translate to IPA**: Formulate the phonetic representation using the character guide (e.g., `React` -> `ʁiˈʔakt`).
3. **Write to Dictionary**:
   - Use `replace_file_content` to add the mapping to [phonikud_backend/phonikud_dictionary.json](file:///c:/Users/Idan4/Desktop/virgo/phonikud_backend/phonikud_dictionary.json).
4. **Validate**: Run the diagnostic test script `uv run phonikud_backend/diagnostic_test.py` to confirm the synthesis works and sounds correct.
