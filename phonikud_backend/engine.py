import os
import re
import sys
import json
# pyrefly: ignore [missing-import]
from phonikud_onnx import Phonikud
# pyrefly: ignore [missing-import]
from phonikud import phonemize
# pyrefly: ignore [missing-import]
import phonikud_tts

class PhonikudEngine:
    def __init__(self, models_dir=None):
        if models_dir is None:
            # Check VIRGO_DATA_DIR or VIRGO_PATH env variables, falling back to the default global IDE storage path
            virgo_dir = os.environ.get("VIRGO_DATA_DIR") or os.environ.get("VIRGO_PATH")
            if virgo_dir:
                # If the variable already ends with 'models', use it directly; otherwise append 'models'
                if os.path.basename(virgo_dir.rstrip("\\/")) == "models":
                    models_dir = virgo_dir
                else:
                    models_dir = os.path.join(virgo_dir, "models")
            else:
                models_dir = os.path.join(os.path.expanduser("~"), ".gemini", "antigravity-ide", "virgo", "models")
            
        self.models_dir = models_dir
        os.makedirs(self.models_dir, exist_ok=True)
        
        # Verify and load models
        self.diacritizer_path = os.path.join(self.models_dir, "phonikud-1.0.int8.onnx")
        self.tokenizer_path = os.path.join(self.models_dir, "tokenizer.json")
        self.tts_model_path = os.path.join(self.models_dir, "shaul.onnx")
        self.tts_config_path = os.path.join(self.models_dir, "model.config.json")
        
        self._ensure_models_exist()
        
        # Initialize diacritizer and TTS engines
        self.diacritizer = Phonikud(self.diacritizer_path)
        self.tts = phonikud_tts.Piper(model_path=self.tts_model_path, config_path=self.tts_config_path)
        
        # Load local package dictionary
        self.dictionary = {}
        local_dict_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "phonikud_dictionary.json")
        if os.path.exists(local_dict_path):
            try:
                with open(local_dict_path, "r", encoding="utf-8") as f:
                    self.dictionary.update(json.load(f))
            except Exception:
                pass
                
        # Load override dictionary from models_dir parent (Virgo data directory)
        virgo_data_dir = os.path.dirname(self.models_dir)
        override_dict_path = os.path.join(virgo_data_dir, "phonikud_dictionary.json")
        
        # Auto-initialize the override dictionary file as a clean empty JSON object if it does not exist
        if not os.path.exists(override_dict_path) and override_dict_path != local_dict_path:
            try:
                with open(override_dict_path, "w", encoding="utf-8") as f:
                    json.dump({}, f, indent=2)
            except Exception:
                pass

        if os.path.exists(override_dict_path) and override_dict_path != local_dict_path:
            try:
                with open(override_dict_path, "r", encoding="utf-8") as f:
                    self.dictionary.update(json.load(f))
            except Exception:
                pass
        
        # Standard G2P letters spelled out dictionary for acronyms
        self.letter_spelled = {
            'a': 'ay', 'b': 'bee', 'c': 'see', 'd': 'dee', 'e': 'ee',
            'f': 'ef', 'g': 'jee', 'h': 'aitch', 'i': 'eye', 'j': 'jay',
            'k': 'kay', 'l': 'el', 'm': 'em', 'n': 'en', 'o': 'oh',
            'p': 'pee', 'q': 'cue', 'r': 'ar', 's': 'ess', 't': 'tee',
            'u': 'you', 'v': 'vee', 'w': 'doubleyou', 'x': 'ex', 'y': 'wy',
            'z': 'zee'
        }
        
        # Patterns for known unstressed English prefixes in Hebrew-friendly G2P (e.g. re-, de-, be-, pre-, con-, ex-, sub-)
        self.prefix_stress_patterns = [
            re.compile(p) for p in [
                r'^ʁ[ie]',   # re-
                r'^d[ie]',   # de-
                r'^b[ie]',   # be-
                r'^pʁ[ie]',  # pre-
                r'^k[oa]n',  # con-
                r'^k[oa]m',  # com-
                r'^ek',      # ex-
                r'^sa[bv]',  # sub-
                r'^tʁa'      # trans-
            ]
        ]

    def _ensure_models_exist(self):
        # Double check presence
        missing = [p for p in [self.diacritizer_path, self.tokenizer_path, self.tts_model_path, self.tts_config_path] if not os.path.exists(p)]
        if missing:
            # Auto-download missing files from Hugging Face
            # pyrefly: ignore [missing-import]
            from huggingface_hub import hf_hub_download
            repo_id = "thewh1teagle/phonikud"
            
            # Map filenames
            mapping = {
                "phonikud-1.0.int8.onnx": "phonikud-1.0.int8.onnx",
                "tokenizer.json": "tokenizer.json",
                "shaul.onnx": "shaul.onnx",
                "model.config.json": "model.config.json"
            }
            
            for file_path in missing:
                filename = os.path.basename(file_path)
                hf_hub_download(
                    repo_id=repo_id,
                    filename=mapping[filename],
                    local_dir=self.models_dir,
                    local_dir_use_symlinks=False
                )

    def _phonemize_word(self, w):
        # pyrefly: ignore [missing-import]
        import eng_to_ipa as ipa
        vowels_set = 'aeiou\u0254\u025b\u00e6e\u026aa\u026ao\u028a\u0259'
        
        w_lower = w.lower()
        if w_lower in self.dictionary:
            return self.dictionary[w_lower]
            
        if w.isupper() and len(w) <= 4:
            # Acronym: spell it out letter by letter and join phonemes cleanly with stress/glottal-stops between letters
            parts = []
            for c in w:
                spelled = self.letter_spelled.get(c.lower(), c)
                raw_ipa = ipa.convert(spelled).replace('ˈ', '').replace('ˌ', '').replace(' ', '')
                parts.append(raw_ipa)
            
            res = 'ˈ'
            for i, part in enumerate(parts):
                if i > 0:
                    # If next part starts with vowel sound, separate with glottal stop ʔ to prevent compression
                    if part[0] in vowels_set:
                        res += 'ˈ\u0294'
                    else:
                        res += 'ˈ'
                res += part
        else:
            res = ipa.convert(w)
            if '*' in res:
                # OOV word: clean asterisk and map ph to f to prevent literal spelling/reading of p-h
                res = res.replace('*', '').replace('ph', 'f').replace('Ph', 'f')
            else:
                res = res.replace('*', '')
        
        # Map standard English G2P ligatures to separated phoneme equivalents supported by Hebrew Piper model
        res = res.replace('ʤ', 'dʒ').replace('ʧ', 'tʃ')
        
        # Map standard English IPA sounds to clean, open Hebrew equivalents to prevent them from being swallowed
        res = res.replace('r', 'ʁ').replace('ɹ', 'ʁ')
        res = res.replace('g', 'ɡ')  # Map standard Latin 'g' to IPA script 'ɡ' used by Hebrew model
        res = res.replace('eɪ', 'ej').replace('aɪ', 'aj').replace('oʊ', 'o').replace('əʊ', 'o')
        res = res.replace('æ', 'a').replace('ʊ', 'u').replace('ʌ', 'a').replace('ə', 'e')
        res = res.replace('ɪ', 'i').replace('ɛ', 'e').replace('ɔ', '\u0254').replace('ɑ', '\u0254')  # Map O-vowels to open-O (ɔ) for Doker/Docker clarity
        res = res.replace('iː', 'i').replace('uː', 'u')
        res = res.replace('θ', 't').replace('ð', 'd')  # Map soft/hard th sounds to standard Hebrew dental plosives t and d
        
        # Dynamic stress assignment for multi-syllable word lacking explicit G2P stress
        if 'ˈ' not in res and 'ˌ' not in res:
            vowels_count = sum(1 for c in res if c in vowels_set)
            if vowels_count >= 2:
                matched_prefix = False
                for pattern in self.prefix_stress_patterns:
                    match = pattern.match(res)
                    if match:
                        idx = match.end()
                        res = res[:idx] + 'ˈ' + res[idx:]
                        matched_prefix = True
                        break
                if not matched_prefix:
                    for idx, char in enumerate(res):
                        if char in vowels_set:
                            res = res[:idx] + 'ˈ' + res[idx:]
                            break
                            
        return res

    def english_fallback(self, w):
        vowels_set = 'aeiou\u0254\u025b\u00e6e\u026aa\u026ao\u028a\u0259'
        
        w_lower = w.lower()
        if w_lower in self.dictionary:
            res = self.dictionary[w_lower]
        else:
            # Split camelCase and compound words (e.g. GitPush -> Git Push, DictaBERT -> Dicta BERT)
            words = re.sub(r'([a-z])([A-Z])', r'\1 \2', w).split()
            res_parts = [self._phonemize_word(word) for word in words]
            res = ''.join(res_parts)
        
        # Ensure compound words lacking stress get stressed on the first syllable
        if 'ˈ' not in res and 'ˌ' not in res:
            vowels_count = sum(1 for c in res if c in vowels_set)
            if vowels_count >= 2:
                for idx, char in enumerate(res):
                    if char in vowels_set:
                        res = res[:idx] + 'ˈ' + res[idx:]
                        break
        
        # Shift stress mark 'ˈ' after consonants so it sits right before the vowel, improving phonetic flow
        res = re.sub(r'ˈ([bcdfɡhjklmnpʁstvwzʃʒθðx]*)', r'\1ˈ', res)
        
        # Insert glottal stop 'ʔ' (Alef transition) between adjacent vowels (even with stress marks) to make English speech sound open and uncompressed
        res = re.sub(r'([aeiou\u0254])([ˈ\u02cc]?)([aeiou\u0254])', r'\1\2' + '\u0294' + r'\3', res)
        res = res.replace('\u0294\u0294', '\u0294').replace('ˈˈ', 'ˈ')
        
        return res

    def vocalize(self, text: str) -> str:
        # 1. Vocalize the entire text using the ONNX diacritizer to preserve full grammatical context
        vocalized = self.diacritizer.add_diacritics(text)
        # 2. Enforce pipe boundary after Hebrew prepositions attached to English words (e.g. "ב-VS" -> "ב|-VS")
        vocalized = re.sub(r'\b([בלהמשכו][\u0591-\u05c7]*)(?=-[a-zA-Z])', r'\1|', vocalized)
        return vocalized

    def g2p(self, vocalized_text: str) -> str:
        # 1. Run G2P using Phonikud's native fallback mechanism for English words
        phonemes = phonemize(vocalized_text, fallback=self.english_fallback)
        
        # 2. Post-process the final phoneme string to correct transitional mismatches
        # Step 1: Join/smooth prepositions with vowels in front of English words (e.g. "b'e  'vərgoʊ" -> "be'vərgoʊ"). Requires a space boundary (\s+).
        phonemes = re.sub(r'\b([blmkvʃ])[ˈ\']?([eiaou])\s+(?=ˈ?[a-zA-Zæɑɔəɛɪɹʃθʊʌ])', r'\1\2', phonemes)
        # Step 2: Join vowelless prepositions in front of English words (e.g. "l' 'eɪpiaɪ" -> "l'eɪpiaɪ"). Requires a space boundary (\s+).
        phonemes = re.sub(r'\b([blmkvʃ])[ˈ\']?\s+(?=ˈ?[a-zA-Zæɑɔəɛɪɹʃθʊʌ])', r'\1', phonemes)
        # Step 3: Recover and attach definite articles (e.g. "ki'a 'titiɛs" -> "ki ha'titiɛs")
        phonemes = re.sub(r'(\b[blmkvʃ]i|\bve|\bʃe|\b)[\sˈ\']*a\s+(?=ˈ?[a-zA-Zæɑɔəɛɪɹʃθʊʌ])', r'\1 ha', phonemes)
        
        return phonemes

    def synthesize(self, phonemes: str, output_wav_path: str, length_scale: float = 0.85):
        # Run Piper TTS model inference
        samples, sample_rate = self.tts.create(phonemes, is_phonemes=True, length_scale=length_scale)
        
        import wave
        # pyrefly: ignore [missing-import]
        import numpy as np
        
        # Convert float32 [-1.0, 1.0] to 16-bit PCM int16
        int16_samples = (samples * 32767.0).astype(np.int16)
        
        with wave.open(output_wav_path, "wb") as wav_file:
            wav_file.setnchannels(1) # mono
            wav_file.setsampwidth(2) # 16-bit
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(int16_samples.tobytes())
            
    def text_to_speech(self, text: str, output_wav_path: str, length_scale: float = 0.85) -> tuple[str, str]:
        vocalized = self.vocalize(text)
        phonemes = self.g2p(vocalized)
        self.synthesize(phonemes, output_wav_path, length_scale)
        return vocalized, phonemes
