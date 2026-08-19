# hf-tts — text-to-speech, dual engine, as a Noosphere compute container.
#
#   Kokoro-82M (Apache-2.0)  — English voices (American 'a', British 'b')
#   MeloTTS    (MIT)         — Korean ("ko" voices)
#
# One service, one price; the `voice` field routes to the engine. Both models
# are baked into the image and loaded (and warmed) at startup — fail-fast: if
# either engine cannot load, the container does not come up healthy.
#
# Contract:
#   POST /computation
#     { "text": "...",              // required; ≤2000 chars (Korean ≤1200)
#       "voice": "af_heart",        // optional; "ko"/"ko_*" -> MeloTTS Korean
#       "speed": 1.0,               // optional, clamped 0.5–2.0
#       "format": "wav" }           // optional, "wav" | "mp3"
#     -> { "output": { "audio_b64", "format", "sample_rate",
#                      "duration_s", "voice", "engine" } }

import base64
import io
import os
import subprocess
import tempfile
import wave

import numpy as np
import torch
import torchaudio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

MAX_TEXT_CHARS = 2000
# Korean speech runs ~0.15s of audio per character (measured) — 1200 chars
# ≈ the 3-minute output ceiling. English at 2000 chars is ~2 minutes.
MAX_TEXT_CHARS_KO = 1200
DEFAULT_VOICE = "af_heart"
# Everything is served at 24kHz — MeloTTS's native 44.1kHz is resampled down
# so Korean responses aren't 1.8× the bytes for no audible speech benefit.
TARGET_SR = 24000

# Curated voices baked into the image (a runtime request for anything else is
# rejected instead of triggering a network download).
KOKORO_VOICES = {
    "af_heart": "a", "af_bella": "a", "am_adam": "a", "am_michael": "a",
    "bf_emma": "b", "bm_george": "b",
}

app = FastAPI()

from kokoro import KPipeline  # noqa: E402

kokoro_pipes = {
    lang: KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M")
    for lang in sorted(set(KOKORO_VOICES.values()))
}

from melo.api import TTS as MeloTTS  # noqa: E402

melo = MeloTTS(language="KR", device="cpu")
MELO_SPEAKER = next(iter(melo.hps.data.spk2id.values()))
MELO_SR = melo.hps.data.sampling_rate


def synth_kokoro(text: str, voice: str, speed: float) -> np.ndarray:
    pipe = kokoro_pipes[KOKORO_VOICES[voice]]
    chunks = [result.audio for result in pipe(text, voice=voice, speed=speed)]
    return torch.cat(chunks).numpy()


def synth_melo(text: str, speed: float) -> np.ndarray:
    # output_path=None returns the audio array instead of writing a file.
    audio = melo.tts_to_file(text, MELO_SPEAKER, None, speed=speed, quiet=True)
    if MELO_SR != TARGET_SR:
        resampled = torchaudio.functional.resample(
            torch.from_numpy(audio).float(), MELO_SR, TARGET_SR)
        return resampled.numpy()
    return audio


def encode_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    pcm16 = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()


def encode_mp3(wav_bytes: bytes) -> bytes:
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "a.wav")
        dst = os.path.join(td, "a.mp3")
        with open(src, "wb") as f:
            f.write(wav_bytes)
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error",
             "-i", src, "-b:a", "64k", dst],
            capture_output=True, timeout=120)
        if proc.returncode != 0:
            raise RuntimeError(f"mp3 encode failed: {proc.stderr.decode(errors='replace')[:200]}")
        with open(dst, "rb") as f:
            return f.read()


# Warm both engines so the first paid call doesn't eat lazy-init latency
# (MeloTTS's first synthesis was measured ~15s slower than steady state).
synth_kokoro("Warm up.", DEFAULT_VOICE, 1.0)
synth_melo("준비 완료.", 1.0)


@app.post("/computation")
async def computation(req: Request):
    body = await req.json()

    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        return JSONResponse(status_code=400, content={"error": "text (non-empty string) is required"})
    if len(text) > MAX_TEXT_CHARS:
        return JSONResponse(status_code=400, content={"error": f"text longer than {MAX_TEXT_CHARS} chars cap"})

    voice = body.get("voice") or DEFAULT_VOICE
    if not isinstance(voice, str):
        return JSONResponse(status_code=400, content={"error": "voice must be a string"})

    speed = body.get("speed", 1.0)
    if not isinstance(speed, (int, float)):
        return JSONResponse(status_code=400, content={"error": "speed must be a number"})
    speed = max(0.5, min(2.0, float(speed)))

    fmt = body.get("format") or "wav"
    if fmt not in ("wav", "mp3"):
        return JSONResponse(status_code=400, content={"error": "format must be \"wav\" or \"mp3\""})

    if voice == "ko" or voice.startswith("ko_"):
        if len(text) > MAX_TEXT_CHARS_KO:
            return JSONResponse(status_code=400, content={
                "error": f"korean text longer than {MAX_TEXT_CHARS_KO} chars cap"})
        audio, engine = synth_melo(text, speed), "melotts"
    elif voice in KOKORO_VOICES:
        audio, engine = synth_kokoro(text, voice, speed), "kokoro"
    else:
        return JSONResponse(status_code=400, content={
            "error": f"unknown voice '{voice}'",
            "voices": sorted(KOKORO_VOICES) + ["ko"],
        })

    duration = len(audio) / TARGET_SR
    wav_bytes = encode_wav(audio, TARGET_SR)
    payload = encode_mp3(wav_bytes) if fmt == "mp3" else wav_bytes

    return {"output": {
        "audio_b64": base64.b64encode(payload).decode(),
        "format": fmt,
        "sample_rate": TARGET_SR,
        "duration_s": round(duration, 2),
        "voice": voice,
        "engine": engine,
    }}


@app.get("/health")
async def health():
    return {"ok": True, "voices": sorted(KOKORO_VOICES) + ["ko"]}
