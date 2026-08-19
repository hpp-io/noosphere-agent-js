# hf-tts — paid text-to-speech (Kokoro + MeloTTS, English/Korean)

Dual-engine TTS in one container, one paid service:

| Engine | License | Voices | Text cap |
|---|---|---|---|
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) | Apache-2.0 | `af_heart` (default), `af_bella`, `am_adam`, `am_michael`, `bf_emma`, `bm_george` | 2,000 chars |
| [MeloTTS](https://github.com/myshell-ai/MeloTTS) Korean | MIT | `ko` | 1,200 chars |

The `voice` field routes to the engine — `ko`/`ko_*` goes to MeloTTS,
everything else to Kokoro. Voices are baked at build time; unknown voices are
rejected (no runtime downloads). All audio is served at 24kHz mono (MeloTTS's
native 44.1kHz is resampled down — same speech quality, 45% of the bytes).
Korean has a lower char cap because it runs ~0.15s of audio per character
(measured) — 1,200 chars ≈ the same ~3-minute output ceiling as English.

## Contract

```
POST /computation
  { "text": "...",          // required; ≤2000 chars (Korean ≤1200)
    "voice": "af_heart",    // optional
    "speed": 1.0,           // optional, clamped 0.5–2.0
    "format": "wav" }       // optional, "wav" | "mp3" (64kbps)
  -> { "output": { "audio_b64",   // base64 (16-bit mono wav, or mp3)
                   "format", "sample_rate", "duration_s",
                   "voice", "engine" } }
```

Response size: ~2 minutes of wav ≈ 7MB of base64; `"format": "mp3"` cuts that
~10×. The selling agent needs the 12mb JSON body limit (in place since the
externalUrl/body-limit release).

## Build & smoke test

```bash
cd examples/hf-tts
docker build -t example-hf-tts-noosphere:latest .   # slow first build: CPU torch + 2 models
docker run --rm -p 8096:8096 example-hf-tts-noosphere:latest

curl -s localhost:8096/computation -H 'content-type: application/json' \
  -d '{"text":"Hello from the paid compute rail.","voice":"af_heart"}' \
  | python3 -c "import sys,json,base64; o=json.load(sys.stdin)['output']; open('out.wav','wb').write(base64.b64decode(o['audio_b64'])); print(o['duration_s'],'s', o['engine'])"

curl -s localhost:8096/computation -H 'content-type: application/json' \
  -d '{"text":"안녕하세요. 유료 컴퓨트 데모입니다.","voice":"ko"}' | head -c 200
```

## Sell it

Same flow as [hf-sentiment](../hf-sentiment/README.md). Service entry sketch:

```jsonc
{
  "name": "tts",
  "containerId": "hf-tts",
  "settlement": "direct",
  "network": "eip155:181228",
  "schemes": ["exact"],
  "x402Price": "8000",            // $0.008/call, ≤2000 chars
  "receipt": true,
  "inputSchema": {
    "type": "object", "required": ["text"],
    "properties": {
      "text": { "type": "string", "maxLength": 2000 },
      "voice": { "type": "string" },
      "speed": { "type": "number" },
      "format": { "type": "string", "enum": ["wav", "mp3"] }
    }
  },
  "description": "Natural speech, instantly - English (6 voices) and Korean. Kokoro + MeloTTS engines; wav or mp3 output; voice and speed control per request; up to 2,000 chars (Korean 1,200). Failed calls are never charged."
}
```

## Build notes (dependency traps)

- torch/torchaudio must come from the **CPU wheel index** before anything else
  installs them transitively, or the image gains multi-GB CUDA wheels.
- MeloTTS pins `transformers==4.27.4`; installing it after kokoro lets the pin
  win. Kokoro does not use transformers at synthesis time.
- MeloTTS imports its Japanese text module even for Korean → `unidic download`
  is required at build time.
- `espeak-ng` (apt) is the G2P fallback for out-of-dictionary English words.
