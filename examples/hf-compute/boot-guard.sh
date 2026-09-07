#!/bin/sh
# Start hf-stt/hf-tts only after the Tailscale IP is up.
#
# Why: both containers publish their port on the Tailscale IP (HF_BIND_IP).
# If Docker starts before tailscaled on boot, that IP does not exist yet, the
# bind fails, and the container is left in "created". restart:always does NOT
# apply — it covers process exit, not start failure (observed: RestartCount=0,
# Error="cannot assign requested address"). So nothing recovers on its own.
#
# Installed as a user crontab @reboot entry on the compute host; see README.md.
# Deliberately independent of any other boot guard on the host.

DIR=$(cd "$(dirname "$0")" && pwd)
LOG=$DIR/boot-guard.log
MAX_WAIT=300   # seconds

log() { echo "$(date -Is) $*" >> "$LOG"; }

# Same source of truth as docker-compose.yml.
if [ -f "$DIR/.env" ]; then
  # shellcheck disable=SC1091
  . "$DIR/.env"
fi
TS_IP=${HF_BIND_IP:-}
if [ -z "$TS_IP" ]; then
  log "ERROR: HF_BIND_IP not set in $DIR/.env — refusing to start (would fall back to 0.0.0.0)"
  exit 1
fi

log "boot-guard start (waiting for TS_IP=$TS_IP)"
i=0
while [ $i -lt $MAX_WAIT ]; do
  if ip -4 addr show 2>/dev/null | grep -q "$TS_IP"; then
    log "Tailscale IP present after ${i}s"
    break
  fi
  sleep 5
  i=$((i + 5))
done

if ! ip -4 addr show 2>/dev/null | grep -q "$TS_IP"; then
  log "ERROR: Tailscale IP not present within ${MAX_WAIT}s — not starting. Check tailscaled"
  exit 1
fi

cd "$DIR" || { log "ERROR: $DIR missing"; exit 1; }
log "docker compose up -d"
docker compose up -d >> "$LOG" 2>&1
log "done:"
docker compose ps >> "$LOG" 2>&1
