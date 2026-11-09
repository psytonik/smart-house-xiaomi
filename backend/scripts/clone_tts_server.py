"""Cloned-voice speech server (Chatterbox Multilingual on MLX), see docs/adr/0023-cloned-assistant-voice.md.

Run with venv-mlx: python scripts/clone_tts_server.py --reference data/voice/reference.wav --port 5056
The backend starts and stops it itself. Listens on 127.0.0.1 only. POST /synthesize {"text": "..."} -> audio/wav; GET /info -> 200 once the model is loaded.

MLX (Apple's own framework) makes this about 3.4 times faster than the PyTorch/MPS version: a phrase is made faster than it is spoken.
"""
import argparse, io, json, os, re, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

os.environ.setdefault("TQDM_DISABLE", "1")  # no progress bars in the backend log

import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model
from ruaccent import RUAccent
from tail_trim import trim_tail

p = argparse.ArgumentParser()
p.add_argument("--reference", required=True)
p.add_argument("--port", type=int, default=5056)
p.add_argument("--model", default="mlx-community/chatterbox-multilingual-v3")
args = p.parse_args()

# Stress marks: the voice puts the stress wrongly by itself ("часов" on the A). RUAccent finds it ("час+ов"); the voice's tokenizer wants the
# vowel followed by a combining acute accent (U+0301).
accent = RUAccent()
accent.load(omograph_model_size="turbo", use_dictionary=True, tiny_mode=False)
_PLUS = re.compile(r"\+([аеёиоуыэюяАЕЁИОУЫЭЮЯ])")


def stress(text):
    try:
        return _PLUS.sub("\\1\u0301", accent.process_all(text))
    except Exception as e:  # noqa: BLE001
        print(f"stress marks failed: {e}", file=sys.stderr, flush=True)
        return text


model = load_model(args.model)


def speak(text):
    """WAV bytes for the text. The model keeps talking past the end of the text (a mumbled "tail") until its token limit, and every token costs
    time: speech is ~25 tokens a second and Russian ~12 characters a second, so allow the text's length plus a margin."""
    chunks = [np.array(r.audio).reshape(-1) for r in model.generate(text=stress(text), ref_audio=args.reference, lang_code="ru", verbose=False, max_new_tokens=int(len(text) * 2.6) + 40)]
    buf = io.BytesIO()
    sf.write(buf, trim_tail(np.concatenate(chunks), model.sr), model.sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


for warm in ("Привет.", "Свет в гостиной включён, температура двадцать два градуса."):  # the first phrases are slower (kernels are built on first use)
    speak(warm)
print("clone voice ready on mlx", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/info":
            return self._send(200, b'{"engine":"chatterbox-mlx"}')
        self._send(404, b"{}")

    def do_POST(self):
        if self.path != "/synthesize":
            return self._send(404, b"{}")
        try:
            text = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))["text"].strip()[:400]
            if not text:
                return self._send(400, b"{}")
            self._send(200, speak(text), "audio/wav")
        except Exception as e:  # noqa: BLE001
            print(f"synthesis failed: {e}", file=sys.stderr, flush=True)
            self._send(500, b"{}")


HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
