#!/usr/bin/env python3
"""Quality battery for the hf-stt / hf-tts paid-compute containers.

Runs against locally started containers (docker compose up) and produces a
markdown report:
  - STT: word/char error rate vs reference transcripts (samples/manifest.json)
  - STT guards: broken audio, over-duration input -> must 4xx
  - TTS: voice x language x speed x format matrix -> audio sanity (duration,
    non-silence RMS, format magic) + STT round-trip intelligibility (CER/WER)

Stdlib only. Usage: python3 quality.py [--stt URL] [--tts URL]
Artifacts land in out/ (listen to spot-check), report in out/REPORT.md.
"""
import argparse
import base64
import io
import json
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.request
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")


def call(url, payload, timeout=600):
    req = urllib.request.Request(url + "/computation", data=json.dumps(payload).encode(),
                                 headers={"content-type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.load(r)
    return time.time() - t0, body["output"]


def expect_4xx(url, payload):
    try:
        call(url, payload, timeout=60)
        return False, "accepted (should have been rejected)"
    except urllib.error.HTTPError as e:
        return 400 <= e.code < 500, f"{e.code}"


def norm_en(s):
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).split()


def norm_ko(s):
    return list(re.sub(r"[^0-9가-힣]", "", s))


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def error_rate(ref, hyp, lang):
    norm = norm_ko if lang == "ko" else norm_en
    r, h = norm(ref), norm(hyp)
    return edit_distance(r, h) / max(1, len(r))


def wav_stats(data):
    with wave.open(io.BytesIO(data)) as w:
        n, sr, sw = w.getnframes(), w.getframerate(), w.getsampwidth()
        frames = w.readframes(n)
    assert sw == 2, f"expected 16-bit, got {sw*8}-bit"
    samples = struct.unpack(f"<{n}h", frames)
    rms = (sum(s * s for s in samples) / max(1, n)) ** 0.5 / 32768
    return n / sr, sr, rms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stt", default="http://127.0.0.1:8095")
    ap.add_argument("--tts", default="http://127.0.0.1:8096")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    report, failures = [], []

    def add(line):
        report.append(line)
        print(line)

    # ---------- STT accuracy ----------
    add("## STT accuracy (vs reference transcripts)\n")
    add("| sample | lang | detected | audio | wall | speed | ER | transcript |")
    add("|---|---|---|---|---|---|---|---|")
    manifest = json.load(open(os.path.join(HERE, "samples", "manifest.json")))
    ers = {}
    for name, meta in manifest.items():
        audio = open(os.path.join(HERE, "samples", name + ".wav"), "rb").read()
        dt, out = call(args.stt, {"audio_b64": base64.b64encode(audio).decode()})
        er = error_rate(meta["ref"], out["text"], meta["lang"])
        ers.setdefault(meta["lang"], []).append(er)
        metric = "CER" if meta["lang"] == "ko" else "WER"
        flag = "" if er <= 0.15 else " ⚠️"
        if er > 0.15:
            failures.append(f"STT {name}: {metric}={er:.2f} > 0.15")
        add(f"| {name} | {meta['lang']} | {out['language']}({out['language_probability']}) "
            f"| {out['duration_s']}s | {dt:.1f}s | {out['duration_s']/dt:.1f}x "
            f"| {metric} {er:.2f}{flag} | {out['text'][:60]} |")
    for lang, vals in ers.items():
        add(f"\n- {lang} mean ER: **{sum(vals)/len(vals):.3f}** (n={len(vals)})")

    # ---------- STT via audio_url (local http server serves a sample) ----------
    add("\n## STT audio_url input\n")
    import functools, http.server, threading
    handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                                directory=os.path.join(HERE, "samples"))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    try:
        # NOTE: the container's SSRF guard blocks loopback — for the local
        # battery we run the container with STT_ALLOW_PRIVATE_URLS=1.
        dt, out = call(args.stt, {"audio_url": f"http://host.docker.internal:{port}/ko-f-normal.wav"})
        ref = manifest["ko-f-normal"]
        er = error_rate(ref["ref"], out["text"], "ko")
        add(f"- url fetch+transcribe: CER {er:.2f} {'OK' if er <= 0.15 else 'FAIL ⚠️'} ({dt:.1f}s)")
        if er > 0.15:
            failures.append(f"STT audio_url: CER {er:.2f}")
        ok, code = expect_4xx(args.stt, {"audio_b64": "QUJD", "audio_url": "http://x/y"})
        add(f"- both inputs -> {code} {'OK' if ok else 'FAIL'}")
        if not ok:
            failures.append("STT guard: both inputs not rejected")
        ok, code = expect_4xx(args.stt, {})
        add(f"- neither input -> {code} {'OK' if ok else 'FAIL'}")
        if not ok:
            failures.append("STT guard: empty input not rejected")
    finally:
        httpd.shutdown()

    # ---------- STT guards ----------
    add("\n## STT guards (must reject without charging)\n")
    ok, code = expect_4xx(args.stt, {"audio_b64": base64.b64encode(b"garbage" * 100).decode()})
    add(f"- broken audio -> {code} {'OK' if ok else 'FAIL'}")
    if not ok:
        failures.append("STT guard: broken audio not rejected")
    # 3:20 of silence exceeds the 180s duration cap (valid wav, decodes fine)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 16000 * 200)
    ok, code = expect_4xx(args.stt, {"audio_b64": base64.b64encode(buf.getvalue()).decode()})
    add(f"- 200s audio (>180s cap) -> {code} {'OK' if ok else 'FAIL'}")
    if not ok:
        failures.append("STT guard: over-duration not rejected")

    # ---------- TTS matrix ----------
    add("\n## TTS matrix (sanity + STT round-trip intelligibility)\n")
    add("| case | wall | audio | speed | rms | roundtrip ER |")
    add("|---|---|---|---|---|---|")
    EN = "The payment settled on chain in about two seconds, and the receipt proves what was computed."
    KO = "결제는 온체인에서 약 이 초 안에 정산되었고, 영수증이 무엇이 계산되었는지 증명합니다."
    cases = [(v, "en", EN, 1.0, "wav") for v in
             ["af_heart", "af_bella", "am_adam", "am_michael", "bf_emma", "bm_george"]]
    cases += [("ko", "ko", KO, 1.0, "wav"), ("ko", "ko", KO, 1.0, "mp3"),
              ("af_heart", "en", EN, 0.5, "wav"), ("af_heart", "en", EN, 2.0, "wav"),
              ("af_heart", "en", EN, 1.0, "mp3")]
    for voice, lang, text, speed, fmt in cases:
        tag = f"{voice}-{speed}x-{fmt}"
        dt, out = call(args.tts, {"text": text, "voice": voice, "speed": speed, "format": fmt})
        audio = base64.b64decode(out["audio_b64"])
        open(os.path.join(OUT, f"tts-{tag}.{fmt}"), "wb").write(audio)
        if fmt == "wav":
            dur, sr, rms = wav_stats(audio)
            sane = dur > 1 and rms > 0.01 and sr == 24000
        else:
            sane = audio[:3] == b"ID3" or audio[0] == 0xFF
            dur, rms = out["duration_s"], None
        if not sane:
            failures.append(f"TTS {tag}: audio sanity failed")
        # round-trip only for normal-speed cases (speed warps STT input on purpose)
        er_s = "-"
        if speed == 1.0 and fmt == "wav":
            _, rt = call(args.stt, {"audio_b64": out["audio_b64"]})
            er = error_rate(text, rt["text"], lang)
            er_s = f"{er:.2f}"
            if er > 0.2:
                failures.append(f"TTS {tag}: round-trip ER {er:.2f} > 0.2")
        add(f"| {tag} | {dt:.1f}s | {out['duration_s']}s | {out['duration_s']/dt:.1f}x "
            f"| {f'{rms:.3f}' if rms is not None else '-'} | {er_s} |")

    # ---------- TTS guards ----------
    add("\n## TTS guards\n")
    ok, code = expect_4xx(args.tts, {"text": "가" * 1300, "voice": "ko"})
    add(f"- korean 1300 chars (>1200 cap) -> {code} {'OK' if ok else 'FAIL'}")
    if not ok:
        failures.append("TTS guard: ko cap not enforced")
    ok, code = expect_4xx(args.tts, {"text": "hi", "voice": "not_a_voice"})
    add(f"- unknown voice -> {code} {'OK' if ok else 'FAIL'}")
    if not ok:
        failures.append("TTS guard: unknown voice not rejected")

    verdict = "PASS" if not failures else "FAIL"
    add(f"\n## Verdict: **{verdict}**")
    for f in failures:
        add(f"- ❌ {f}")
    open(os.path.join(OUT, "REPORT.md"), "w").write("\n".join(report) + "\n")
    print(f"\nreport: {os.path.join(OUT, 'REPORT.md')}")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
