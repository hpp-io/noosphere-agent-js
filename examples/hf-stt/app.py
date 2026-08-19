# hf-stt — speech-to-text (faster-whisper, Whisper small int8) as a Noosphere
# compute container.
#
# Contract (same as every sellable container):
#   POST /computation  { "input": "<raw string>", ...parsed-json-fields }
#   -> respond { "output": <string or object> }
#
# Buyer input fields:
#   audio_b64   required — base64-encoded audio (wav/mp3/m4a/ogg/webm), ≤5MB decoded
#   language    optional — "auto" (default) or an ISO code like "ko", "en"
#   timestamps  optional — true to include per-segment start/end times
#
# Caps are enforced here (defense in depth behind the agent's inputGuard):
# decoded size ≤ MAX_AUDIO_BYTES, decoded duration ≤ MAX_DURATION_S. Errors
# return 4xx, which the agent maps to a 502 for the buyer WITHOUT settling
# the payment (serve-then-settle).

import base64
import io
import os
import subprocess
import tempfile
import wave

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

# 8MB: a full 3-minute 16kHz/16-bit mono wav is ~5.8MB — a 5MB cap would
# contradict the duration cap for uncompressed uploads. 8MB decoded ≈ 10.7MB
# base64, still inside the agent's 12mb JSON body limit.
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_DURATION_S = 180  # 3 minutes
# Decode a little past the cap so we can tell "too long" from "at the cap",
# while bounding ffmpeg CPU for arbitrarily long uploads.
DECODE_LIMIT_S = MAX_DURATION_S + 10

MODEL_NAME = os.environ.get("STT_MODEL", "small")
CPU_THREADS = int(os.environ.get("STT_THREADS", "4"))

app = FastAPI()

# Loaded once at startup; the CTranslate2 model is baked into the image at
# build time so this is a warm cache read, not a download.
model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=CPU_THREADS)


def decode_to_wav(data: bytes, workdir: str) -> tuple[str, float]:
    """ffmpeg: any supported container/codec -> 16kHz mono wav file.

    Returns (wav_path, duration_s). Decoding stops at DECODE_LIMIT_S so a
    too-long upload costs bounded CPU before being rejected.
    """
    src = os.path.join(workdir, "input.bin")
    dst = os.path.join(workdir, "audio.wav")
    with open(src, "wb") as f:
        f.write(data)
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-i", src, "-t", str(DECODE_LIMIT_S),
         "-ac", "1", "-ar", "16000", "-f", "wav", dst],
        capture_output=True, timeout=120,
    )
    if proc.returncode != 0:
        raise ValueError(f"audio decode failed: {proc.stderr.decode(errors='replace')[:300]}")
    with wave.open(dst) as w:
        duration = w.getnframes() / w.getframerate()
    return dst, duration


@app.post("/computation")
async def computation(req: Request):
    body = await req.json()

    audio_b64 = body.get("audio_b64")
    if not isinstance(audio_b64, str) or not audio_b64:
        return JSONResponse(status_code=400, content={"error": "audio_b64 (base64 string) is required"})
    try:
        data = base64.b64decode(audio_b64, validate=True)
    except Exception:
        return JSONResponse(status_code=400, content={"error": "audio_b64 is not valid base64"})
    if len(data) > MAX_AUDIO_BYTES:
        return JSONResponse(status_code=400, content={"error": f"audio exceeds {MAX_AUDIO_BYTES // (1024*1024)}MB decoded"})

    language = body.get("language") or "auto"
    if not isinstance(language, str):
        return JSONResponse(status_code=400, content={"error": "language must be a string"})
    want_timestamps = bool(body.get("timestamps", False))

    with tempfile.TemporaryDirectory() as td:
        try:
            wav_path, duration = decode_to_wav(data, td)
        except ValueError as e:
            return JSONResponse(status_code=400, content={"error": str(e)})
        if duration > MAX_DURATION_S:
            return JSONResponse(status_code=400, content={"error": f"audio longer than {MAX_DURATION_S}s cap"})

        segments, info = model.transcribe(
            wav_path,
            language=None if language == "auto" else language,
        )
        out_segments = []
        texts = []
        for seg in segments:  # generator — consumes here
            texts.append(seg.text)
            if want_timestamps:
                out_segments.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()})

    output = {
        "text": "".join(texts).strip(),
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration_s": round(duration, 2),
    }
    if want_timestamps:
        output["segments"] = out_segments
    return {"output": output}


@app.get("/health")
async def health():
    return {"ok": True, "model": MODEL_NAME}
