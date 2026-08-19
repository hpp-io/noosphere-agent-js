# hf-stt — speech-to-text (faster-whisper, Whisper small int8) as a Noosphere
# compute container.
#
# Contract (same as every sellable container):
#   POST /computation  { "input": "<raw string>", ...parsed-json-fields }
#   -> respond { "output": <string or object> }
#
# Buyer input fields (audio_b64 XOR audio_url — exactly one):
#   audio_b64   base64-encoded audio (wav/mp3/m4a/ogg/webm), ≤8MB decoded
#   audio_url   http(s) URL of an audio file — fetched server-side (SSRF-guarded),
#               so isolated clients can transcribe without uploading
#   language    optional — "auto" (default) or an ISO code like "ko", "en"
#   timestamps  optional — true to include per-segment start/end times
#
# Caps are enforced here (defense in depth behind the agent's inputGuard):
# decoded size ≤ MAX_AUDIO_BYTES, decoded duration ≤ MAX_DURATION_S. Errors
# return 4xx, which the agent maps to a 502 for the buyer WITHOUT settling
# the payment (serve-then-settle).

import base64
import io
import ipaddress
import os
import socket
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
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


DOWNLOAD_TIMEOUT_S = 30
MAX_REDIRECTS = 3


def assert_public_host(url: str) -> None:
    """SSRF guard: every resolved address must be public. Blocks loopback,
    private RFC1918, link-local (cloud metadata 169.254.x), CGNAT 100.64/10
    (this deployment's own tailnet), and their IPv6 equivalents."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"audio_url scheme must be http(s), got {parsed.scheme!r}")
    host = parsed.hostname
    if not host:
        raise ValueError("audio_url has no host")
    # Test-only escape hatch for the local e2e harness (its sample server is
    # on the docker host). NEVER set in production.
    if os.environ.get("STT_ALLOW_PRIVATE_URLS") == "1":
        return
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise ValueError(f"audio_url host does not resolve: {e}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
                or ip.is_reserved or ip.is_unspecified
                or (ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"))):
            raise ValueError(f"audio_url resolves to a non-public address ({ip})")


def download_audio(url: str) -> bytes:
    """Fetch with per-hop SSRF re-validation, a size cap enforced both via
    Content-Length and during streaming, and a hard timeout."""
    for _ in range(MAX_REDIRECTS + 1):
        assert_public_host(url)
        req = urllib.request.Request(url, headers={"User-Agent": "hf-stt/1.0"}, method="GET")

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None

        opener = urllib.request.build_opener(NoRedirect)
        try:
            res = opener.open(req, timeout=DOWNLOAD_TIMEOUT_S)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                url = urllib.parse.urljoin(url, e.headers["Location"])
                continue
            raise ValueError(f"audio_url fetch failed: HTTP {e.code}")
        with res:
            length = res.headers.get("Content-Length")
            if length and int(length) > MAX_AUDIO_BYTES:
                raise ValueError(f"audio_url content exceeds {MAX_AUDIO_BYTES // (1024*1024)}MB")
            chunks, total = [], 0
            while True:
                chunk = res.read(256 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_AUDIO_BYTES:
                    raise ValueError(f"audio_url content exceeds {MAX_AUDIO_BYTES // (1024*1024)}MB")
                chunks.append(chunk)
            return b"".join(chunks)
    raise ValueError(f"audio_url exceeded {MAX_REDIRECTS} redirects")


@app.post("/computation")
async def computation(req: Request):
    body = await req.json()

    audio_b64 = body.get("audio_b64")
    audio_url = body.get("audio_url")
    if bool(audio_b64) == bool(audio_url):
        return JSONResponse(status_code=400, content={"error": "provide exactly one of audio_b64 or audio_url"})

    if audio_url:
        if not isinstance(audio_url, str):
            return JSONResponse(status_code=400, content={"error": "audio_url must be a string"})
        try:
            data = download_audio(audio_url)
        except ValueError as e:
            return JSONResponse(status_code=400, content={"error": str(e)})
        except Exception as e:
            return JSONResponse(status_code=400, content={"error": f"audio_url fetch failed: {e}"})
    else:
        if not isinstance(audio_b64, str):
            return JSONResponse(status_code=400, content={"error": "audio_b64 must be a string"})
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
