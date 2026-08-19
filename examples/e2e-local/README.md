# e2e-local — local stage for paid-compute services

Run the full stack on your workstation **before** anything touches a server:
containers → quality battery → a real paid e2e through a locally booted agent.
Produced for hf-stt/hf-tts; the pattern generalizes to any new service.

## 1. Build & start the containers

```bash
docker build -t example-hf-stt-noosphere:local ../hf-stt
docker build -t example-hf-tts-noosphere:local ../hf-tts
docker compose up -d
```

## 2. Quality battery

```bash
./gen-samples.sh        # macOS: reference speech via `say` (en/ko, m/f, fast)
python3 quality.py      # exits non-zero on any failure
```

Covers: STT word/char error rate vs references, input guards (broken audio,
over-cap duration), a TTS voice × speed × format matrix with audio sanity
checks, STT round-trip intelligibility scoring, and TTS guards. Report lands
in `out/REPORT.md`, audio artifacts in `out/` for human listening.

## 3. Local paid e2e (real settlement rail, local everything else)

Boot an agent on this machine pointing at the local containers via
`containers[].externalUrl` — payment verification and settlement go through
the real facilitator + testnet chain, so the whole x402 path is exercised:

```bash
cd agent-run
# once: write config.json (chain params + services; see the committed example)
# once: PRIVATE_KEY=0x… KEYSTORE_PASSWORD=… npx tsx ../../..//scripts/init-keystore.ts
NOOSPHERE_CONFIG_PATH=$PWD/config.json KEYSTORE_PASSWORD=… EXPRESS_PORT=4021 \
  npx tsx ../../../src/app.ts
```

Then pay it with any x402 buyer (e.g. hpp-x402-agent-sample 01-hello-world
wallet) against `http://localhost:4021/paid/compute/<service>` and check the
`payment-response` header for the settle transaction.

Gotchas (found the first time this stage ran):
- `schema.sql` is resolved from **process.cwd()** — copy it into `agent-run/`
  (or run from the repo root) or the seller job tables silently don't exist
  and paid calls 500.
- `chain.wallet.keystorePath` is cwd-relative too — use an absolute path.
- Set `deploymentBlock` to a recent block for a fast boot; leave `wsRpcUrl`
  unset; `discovery.enabled: false` so the local agent never registers.

`agent-run/keystore.json` + `config.json` are local artifacts — never commit
keys.
