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

import sys
import os
import json
import argparse
import traceback

# Add parent directory of backend.py to sys.path to enable imports of phonikud_backend
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def log_error(msg):
    sys.stderr.write(f"[ERROR] {msg}\n")
    sys.stderr.flush()

def log_info(msg):
    sys.stderr.write(f"[INFO] {msg}\n")
    sys.stderr.flush()

def main():
    parser = argparse.ArgumentParser(description="Phonikud G2P/TTS JSON-RPC Daemon")
    parser.add_argument("--models-dir", type=str, default=None, help="Directory containing ONNX models")
    args = parser.parse_args()

    log_info("Initializing PhonikudEngine...")
    try:
        from phonikud_backend import PhonikudEngine
        engine = PhonikudEngine(models_dir=args.models_dir)
        log_info(f"PhonikudEngine initialized with models_dir: {engine.models_dir}")
    except Exception as e:
        log_error(f"Failed to initialize PhonikudEngine: {str(e)}")
        log_error(traceback.format_exc())
        sys.exit(1)

    log_info("JSON-RPC Daemon listening on stdin...")
    
    # Configure UTF-8 encoding for stdin/stdout on Windows/other systems to support Hebrew characters
    if sys.platform == 'win32':
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    sys.stdin = open(sys.stdin.fileno(), mode='r', encoding='utf-8', closefd=False)
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', closefd=False)

    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break # EOF reached, parent process exited
            
            line = line.strip()
            if not line:
                continue

            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                log_error(f"Invalid JSON received: {line}")
                response = {
                    "jsonrpc": "2.0",
                    "error": {"code": -32700, "message": "Parse error"},
                    "id": None
                }
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()
                continue

            request_id = request.get("id")
            method = request.get("method")
            params = request.get("params", {})

            if not method:
                response = {
                    "jsonrpc": "2.0",
                    "error": {"code": -32600, "message": "Invalid Request: missing method"},
                    "id": request_id
                }
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()
                continue

            try:
                result = None
                if method == "ping":
                    result = {"status": "ok"}
                elif method == "vocalize":
                    text = params.get("text")
                    if text is None:
                        raise ValueError("Missing parameter: text")
                    result = engine.vocalize(text)
                elif method == "g2p":
                    vocalized_text = params.get("vocalized_text")
                    if vocalized_text is None:
                        raise ValueError("Missing parameter: vocalized_text")
                    result = engine.g2p(vocalized_text)
                elif method == "synthesize":
                    phonemes = params.get("phonemes")
                    output_wav_path = params.get("output_wav_path")
                    length_scale = params.get("length_scale", 0.85)
                    if phonemes is None or output_wav_path is None:
                        raise ValueError("Missing parameters: phonemes or output_wav_path")
                    engine.synthesize(phonemes, output_wav_path, length_scale)
                    result = {"success": True}
                elif method == "text_to_speech":
                    text = params.get("text")
                    output_wav_path = params.get("output_wav_path")
                    length_scale = params.get("length_scale", 0.85)
                    if text is None or output_wav_path is None:
                        raise ValueError("Missing parameters: text or output_wav_path")
                    vocalized, phonemes = engine.text_to_speech(text, output_wav_path, length_scale)
                    result = {"vocalized": vocalized, "phonemes": phonemes}
                else:
                    response = {
                        "jsonrpc": "2.0",
                        "error": {"code": -32601, "message": f"Method not found: {method}"},
                        "id": request_id
                    }
                    sys.stdout.write(json.dumps(response) + "\n")
                    sys.stdout.flush()
                    continue

                response = {
                    "jsonrpc": "2.0",
                    "result": result,
                    "id": request_id
                }
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()

            except Exception as method_exc:
                log_error(f"Error executing method {method}: {str(method_exc)}")
                response = {
                    "jsonrpc": "2.0",
                    "error": {
                        "code": -32603,
                        "message": f"Internal error during execution: {str(method_exc)}",
                        "data": traceback.format_exc()
                    },
                    "id": request_id
                }
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()

        except Exception as loop_exc:
            log_error(f"Fatal error in daemon loop: {str(loop_exc)}")
            break

if __name__ == "__main__":
    main()
