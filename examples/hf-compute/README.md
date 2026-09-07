# hf-compute — remote paid compute host (hf-stt / hf-tts)

Deployment files for the host that runs the speech containers the selling agent
resells over the tailnet via `containers[].externalUrl`
(see `examples/hf-stt`, `examples/hf-tts`, and `feat: external compute containers`, PR #22).

This directory is the git copy of what runs on the compute host. Keep it
byte-identical to the host: the point is that a host loss is recoverable.

## Layout on the host

```
~/hf-compute/
  docker-compose.yml   # this file
  boot-guard.sh        # this file, run from the user's crontab: @reboot
  .env                 # HF_BIND_IP=<Tailscale IP>   (untracked, see .env.example)
  stt-data/ tts-data/  # bind mounts (/data in the containers)
  boot-guard.log
```

Install the crontab entry once:

```
@reboot /home/<user>/hf-compute/boot-guard.sh
```

## Payment boundary: bind to the Tailscale IP only

The containers have no auth of their own. x402 payment is enforced by the
selling agent in front of them, so **any address that can reach the raw port
gets the service for free**. Therefore:

- Ports are published on `${HF_BIND_IP}` only, never `0.0.0.0`.
- `HF_BIND_IP` uses the `:?` form, so compose refuses to start when it is
  unset instead of silently publishing on every interface.
- `boot-guard.sh` refuses to start for the same reason.

Do not "fix" a bind failure by widening the address.

## Why boot-guard.sh exists

Publishing on a Tailscale IP is boot-order dependent. If Docker comes up before
tailscaled, the bind fails with `cannot assign requested address`, the
container stays in `created`, and `restart: always` does **not** kick in (it
covers process exit, not start failure; observed `RestartCount=0`). The guard
waits up to 300 s for the IP, then runs `docker compose up -d` (idempotent:
running containers are left untouched).

## Images

`image:` references the local tag the host was built with. The registry copy is
`ghcr.io/hpp-io/example-hf-{stt,tts}-noosphere` (built by the
`build-example-images` workflow from `examples/hf-stt`, `examples/hf-tts`).

Tags:

- `prod-YYYYMMDD` — the exact image a host is running, pushed from that host
  (`docker tag` + `docker push`, no rebuild). Use these for recovery.
- `YYYY-MM-DD` — a CI build from `main` at dispatch time. May differ from what
  runs: dependencies are unpinned and `main` may have moved.
- `latest` — whichever of the two was pushed last.

Before pulling a registry tag for recovery, check it carries the app.py you
expect: the workflow builds whatever `main` is at dispatch time, and the
dependency tree is not pinned in the Dockerfiles, so two builds of the same
Dockerfile are not guaranteed identical. Compare the `COPY app.py` layer or the
tag's recorded commit against `main` before trusting it. Tag names alone do
not say which app.py they carry.

## Changing anything here (host is live, paid traffic)

1. `docker compose up -d --dry-run` first. A running container must show as
   `Running`, not `Recreate`. Note: changing `image:` (even to the same image
   under a registry name) changes the service config hash and **will**
   recreate the container. Plan that as a maintenance window.
2. Apply, then confirm the container IDs did not change and
   `curl http://$HF_BIND_IP:8095/health` and `:8096/health` return 200.
