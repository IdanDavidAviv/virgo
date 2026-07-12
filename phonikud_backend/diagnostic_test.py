# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "huggingface-hub",
#     "onnxruntime",
#     "phonikud",
#     "phonikud-tts",
#     "eng-to-ipa",
# ]
# ///

import os
import sys

def log(msg):
    print(f"[DIAGNOSTIC] {msg}", flush=True)

def main():
    log("Starting Modularized Engine Diagnostics (Phase 0)...")
    log(f"Python Version: {sys.version}")

    base_dir = os.path.dirname(os.path.abspath(__file__))
    
    try:
        # Include current dir in path to make sure local package is importable
        sys.path.insert(0, os.path.dirname(base_dir))
        # pyrefly: ignore [missing-import]
        from phonikud_backend import PhonikudEngine
        
        # Load the engine pointing to the local models folder
        engine = PhonikudEngine()
        
        test_cases = [
            ("מערכת ה-Daemon החדשה תרוץ בתוך Docker ותבצע פונמיזציה מהירה של משפטים משולבים.", "daemon_docker.wav"),
            ("משתמשי Virgo יוכלו לבחור ב-Piper TTS בהגדרות התוסף כדי לשפר את איכות ההקראה המקומית.", "virgo_piper_tts.wav"),
            ("בזכות התמיכה של DictaBERT בניקוד, הקשר בין עברית לאנגלית ב-API הופך להרבה יותר חלק.", "dictabert_api.wav"),
            ("אל תשכח לעשות GitPush לאחר הטמעת ה-PhonikudEngine כדי שהבדיקות ב-CI יעברו בהצלחה.", "gitpush_ci.wav"),
            ("אפליקציית NextJS מריצה בדיקות מהירות בעזרת Vitest.", "nextjs_vitest.wav"),
            ("קובץ ה-middleware מבצע Oauth מול שרת ה-Auth.", "middleware_auth.wav"),
            ("שימוש ב-TypeScript מונע שגיאות runtime בזמן ה-build.", "typescript_build.wav"),
            ("נבדוק את הקישור ל-GitHub וכן את פריסת הקוד ב-GitLab.", "github_gitlab.wav")
        ]
        
        output_dir = os.path.join(base_dir, "test_outputs")
        os.makedirs(output_dir, exist_ok=True)
        
        for idx, (test_text, filename) in enumerate(test_cases):
            log(f"\n[CASE {idx+1}] Processing: '{test_text}'")
            # Format filename with 2-digit sequential index prefix (e.g. 01_daemon_docker.wav)
            numbered_filename = f"{idx+1:02d}_{filename}"
            output_wav = os.path.join(output_dir, numbered_filename)
            
            vocalized, phonemes = engine.text_to_speech(test_text, output_wav, length_scale=0.85)
            
            log(f"[SENTENCE {idx+1}] Vocalized Hebrew text: '{vocalized}'")
            log(f"[SENTENCE {idx+1}] Generated IPA phonemes: '{phonemes}'")
            log(f"[SENTENCE {idx+1}] SUCCESS: Generated test audio file at: {output_wav}")
            log(f"[SENTENCE {idx+1}] Audio file size: {os.path.getsize(output_wav)} bytes")

    except Exception as e:
        log(f"ERROR during G2P/TTS synthesis run: {str(e)}")
        import traceback
        log(traceback.format_exc())
        sys.exit(1)

if __name__ == "__main__":
    main()
