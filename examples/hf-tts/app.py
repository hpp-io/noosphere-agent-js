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


# ==================== Long-form async jobs ====================
#
# The sync route caps at 2,000 chars because the caller waits and the audio
# rides one JSON response. Jobs lift both limits for narration-length text
# (articles, newsletters, audiobook chapters — up to 50,000 chars):
#
#   POST /jobs {text, voice?, speed?}   -> {"jobId", "status": "queued"}
#   GET  /jobs/{jobId}                  -> {"status", "durationS"?, "error"?}
#   GET  /jobs/{jobId}/audio            -> audio/mpeg binary (mp3)
#
# The worker splits the text on sentence boundaries into engine-sized chunks,
# synthesizes serially (sharing the engines with the sync route), concatenates
# the audio and encodes one mp3 under /data (mount a volume). The paying agent
# bills the reported output duration (upto: per-minute, settle-on-completion).

import re as _re
import sqlite3
import threading
import time
import uuid

MAX_JOB_TEXT_CHARS = int(os.environ.get("TTS_JOB_MAX_CHARS", 50_000))
MAX_JOB_OUTPUT_S = int(os.environ.get("TTS_JOB_MAX_OUTPUT_S", 7200))  # 2h of audio
JOB_TTL_HOURS = int(os.environ.get("TTS_JOB_TTL_HOURS", 72))
JOBS_DB = os.environ.get("TTS_JOBS_DB", "/data/jobs.db")
AUDIO_DIR = os.environ.get("TTS_JOB_AUDIO_DIR", "/data/audio")

SYNTH_LOCK = threading.Lock()


def _jobs_conn() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(JOBS_DB), exist_ok=True)
    conn = sqlite3.connect(JOBS_DB)
    conn.execute("""CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        text TEXT NOT NULL,
        voice TEXT NOT NULL,
        speed REAL NOT NULL,
        duration_s REAL,
        error TEXT,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL)""")
    conn.commit()
    return conn


def _job_update(job_id: str, **fields) -> None:
    conn = _jobs_conn()
    sets = ", ".join(f"{k} = ?" for k in fields) + ", updated_at = ?"
    conn.execute(f"UPDATE jobs SET {sets} WHERE id = ?", [*fields.values(), time.time(), job_id])
    conn.commit()
    conn.close()


def chunk_text(text: str, limit: int) -> list:
    """Split on sentence boundaries (fall back to hard cuts) into ≤limit chunks."""
    sentences = _re.split(r"(?<=[.!?。！？…])\s+|\n{2,}", text)
    chunks, cur = [], ""
    for s in sentences:
        s = s.strip()
        if not s:
            continue
        while len(s) > limit:  # pathological sentence — hard cut
            head, s = s[:limit], s[limit:]
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(head)
        if len(cur) + len(s) + 1 > limit:
            chunks.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        chunks.append(cur)
    return chunks


def _process_job(job_id: str, text: str, voice: str, speed: float) -> None:
    _job_update(job_id, status="processing")
    is_ko = voice == "ko" or voice.startswith("ko_")
    limit = MAX_TEXT_CHARS_KO if is_ko else MAX_TEXT_CHARS
    parts = []
    total_s = 0.0
    for chunk in chunk_text(text, limit):
        with SYNTH_LOCK:
            audio = synth_melo(chunk, speed) if is_ko else synth_kokoro(chunk, voice, speed)
        parts.append(audio)
        total_s += len(audio) / TARGET_SR
        if total_s > MAX_JOB_OUTPUT_S:
            raise ValueError(f"output longer than {MAX_JOB_OUTPUT_S}s cap")
    joined = np.concatenate(parts) if len(parts) > 1 else parts[0]
    duration = len(joined) / TARGET_SR
    os.makedirs(AUDIO_DIR, exist_ok=True)
    mp3 = encode_mp3(encode_wav(joined, TARGET_SR))
    with open(os.path.join(AUDIO_DIR, f"{job_id}.mp3"), "wb") as f:
        f.write(mp3)
    _job_update(job_id, status="completed", duration_s=round(duration, 2))


def _worker_loop() -> None:
    conn = _jobs_conn()
    conn.execute("UPDATE jobs SET status='failed', error='container restarted mid-job', updated_at=? "
                 "WHERE status='processing'", [time.time()])
    conn.commit()
    conn.close()

    last_sweep = 0.0
    while True:
        try:
            conn = _jobs_conn()
            if time.time() - last_sweep > 3600:
                old = conn.execute("SELECT id FROM jobs WHERE updated_at < ?",
                                   [time.time() - JOB_TTL_HOURS * 3600]).fetchall()
                for (jid,) in old:
                    try:
                        os.remove(os.path.join(AUDIO_DIR, f"{jid}.mp3"))
                    except OSError:
                        pass
                conn.execute("DELETE FROM jobs WHERE updated_at < ?",
                             [time.time() - JOB_TTL_HOURS * 3600])
                conn.commit()
                last_sweep = time.time()
            row = conn.execute(
                "SELECT id, text, voice, speed FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
            ).fetchone()
            conn.close()
            if not row:
                time.sleep(2)
                continue
            job_id, text, voice, speed = row
            try:
                _process_job(job_id, text, voice, speed)
            except Exception as e:  # noqa: BLE001 — job failure must not kill the worker
                _job_update(job_id, status="failed", error=str(e)[:500])
        except Exception:
            time.sleep(5)


threading.Thread(target=_worker_loop, daemon=True).start()


@app.post("/jobs")
async def submit_job(req: Request):
    body = await req.json()
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        return JSONResponse(status_code=400, content={"error": "text is required for jobs"})
    if len(text) > MAX_JOB_TEXT_CHARS:
        return JSONResponse(status_code=400, content={"error": f"text longer than {MAX_JOB_TEXT_CHARS} chars job cap"})
    voice = body.get("voice") or DEFAULT_VOICE
    if not (voice == "ko" or voice.startswith("ko_") or voice in KOKORO_VOICES):
        return JSONResponse(status_code=400, content={"error": f"unknown voice '{voice}'",
                                                      "voices": sorted(KOKORO_VOICES) + ["ko"]})
    speed = body.get("speed", 1.0)
    if not isinstance(speed, (int, float)):
        return JSONResponse(status_code=400, content={"error": "speed must be a number"})
    job_id = uuid.uuid4().hex
    conn = _jobs_conn()
    conn.execute("INSERT INTO jobs (id, status, text, voice, speed, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                 [job_id, "queued", text, voice, max(0.5, min(2.0, float(speed))), time.time(), time.time()])
    conn.commit()
    conn.close()
    return {"jobId": job_id, "status": "queued", "maxOutputS": MAX_JOB_OUTPUT_S, "ttlHours": JOB_TTL_HOURS}


@app.get("/jobs/{job_id}")
async def job_status(job_id: str):
    conn = _jobs_conn()
    row = conn.execute("SELECT status, duration_s, error FROM jobs WHERE id = ?", [job_id]).fetchone()
    conn.close()
    if not row:
        return JSONResponse(status_code=404, content={"error": "unknown jobId"})
    status, duration_s, error = row
    out = {"jobId": job_id, "status": status}
    if duration_s is not None:
        out["durationS"] = duration_s
    if status == "completed":
        out["audioPath"] = f"/jobs/{job_id}/audio"
        out["format"] = "mp3"
    if error:
        out["error"] = error
    return out


@app.get("/jobs/{job_id}/audio")
async def job_audio(job_id: str):
    from fastapi.responses import FileResponse
    path = os.path.join(AUDIO_DIR, f"{job_id}.mp3")
    if not os.path.exists(path):
        return JSONResponse(status_code=404, content={"error": "no audio (job incomplete or expired)"})
    return FileResponse(path, media_type="audio/mpeg", filename=f"{job_id}.mp3")
