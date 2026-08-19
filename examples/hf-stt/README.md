# hf-stt — paid speech-to-text (faster-whisper small)

Wraps [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (Whisper
small, int8, CPU) as a Noosphere compute container. 99 languages including
Korean. No torch, no GPU — CTranslate2 inference, ~1GB RAM resident.

## Contract

```
POST /computation
  { "audio_b64": "<base64 wav/mp3/m4a/ogg/webm>",   // ≤8MB decoded — exactly one of
    "audio_url": "https://…/clip.mp3",               //   audio_b64 / audio_url
    "language": "auto" | "ko" | "en" | ...,          // optional, default auto
    "timestamps": false }                             // optional
  -> { "output": { "text", "language", "language_probability",
                   "duration_s", "segments"? } }
```

`audio_url` is fetched server-side (http/https only, ≤3 redirects, 8MB cap
enforced while streaming) behind an SSRF guard that rejects loopback,
private, link-local (cloud metadata) and CGNAT/tailnet addresses — so
isolated clients can transcribe without uploading. `STT_ALLOW_PRIVATE_URLS=1`
disables the guard for the local e2e harness only.

Caps: decoded audio ≤8MB and ≤180s (3 minutes). Violations return 4xx, which
the agent surfaces as 502 **without settling the payment**.

## Build & smoke test

```bash
cd examples/hf-stt
docker build -t example-hf-stt-noosphere:latest .   # bakes the ~460MB model
docker run --rm -p 8095:8095 example-hf-stt-noosphere:latest

AUDIO=$(base64 -i sample.wav)
curl -s localhost:8095/computation -H 'content-type: application/json' \
  -d "{\"audio_b64\":\"$AUDIO\",\"language\":\"auto\"}"
```

## Sell it

Same flow as [hf-sentiment](../hf-sentiment/README.md). Service entry sketch:

```jsonc
{
  "name": "stt",
  "containerId": "hf-stt",
  "settlement": "direct",
  "network": "eip155:181228",
  "schemes": ["exact"],
  "x402Price": "10000",           // $0.010/call, ≤3min audio
  "receipt": true,
  "inputSchema": {
    "type": "object", "required": ["audio_b64"],
    "properties": {
      "audio_b64": { "type": "string" },
      "language": { "type": "string" },
      "timestamps": { "type": "boolean" }
    }
  },
  "description": "Accurate transcription in seconds - 99 languages, auto-detected. Powered by Whisper. Accepts wav/mp3/m4a/ogg/webm up to 3 minutes; returns the transcript with language confidence and optional timestamps. Failed calls are never charged."
}
```

The agent must run with a raised JSON body limit (12mb) — base64 audio does
not fit the express default. Supported since the externalUrl/body-limit
release; the container itself can also live on another host via
`containers[].externalUrl`.

Env knobs: `STT_MODEL` (default `small`), `STT_THREADS` (default `4`).
