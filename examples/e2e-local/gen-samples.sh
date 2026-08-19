#!/usr/bin/env bash
# Generate STT test samples with reference transcripts (macOS `say`).
# Output: samples/*.wav + samples/manifest.json
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p samples

gen() { # gen <name> <voice> <rate> <text>
  local name=$1 voice=$2 rate=$3 text=$4
  say -v "$voice" -r "$rate" -o "samples/$name.aiff" "$text"
  afconvert -f WAVE -d LEI16@16000 -c 1 "samples/$name.aiff" "samples/$name.wav"
  rm "samples/$name.aiff"
}

EN1="The quick brown fox jumps over the lazy dog near the river bank."
EN2="Autonomous agents can buy and sell compute with on chain payments, and every call produces a verifiable receipt."
KO1="안녕하세요. 오늘 회의는 오후 세 시에 시작합니다. 장소는 삼 층 회의실입니다."
KO2="누스피어 프로토콜은 자율 에이전트가 온체인 결제로 연산을 사고팔 수 있게 합니다. 각 호출은 몇 초 안에 정산됩니다."

gen en-f-normal Samantha 175 "$EN1"
gen en-m-normal Daniel   175 "$EN2"
gen en-f-fast   Samantha 260 "$EN2"
gen ko-f-normal Yuna     175 "$KO1"
gen ko-f-fast   Yuna     240 "$KO2"

python3 - <<EOF
import json
manifest = {
  "en-f-normal": {"lang": "en", "ref": "$EN1"},
  "en-m-normal": {"lang": "en", "ref": "$EN2"},
  "en-f-fast":   {"lang": "en", "ref": "$EN2"},
  "ko-f-normal": {"lang": "ko", "ref": "$KO1"},
  "ko-f-fast":   {"lang": "ko", "ref": "$KO2"},
}
json.dump(manifest, open("samples/manifest.json", "w"), ensure_ascii=False, indent=1)
print("samples:", len(manifest))
EOF
