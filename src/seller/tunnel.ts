/**
 * Demo tunnel (TEST ONLY) — Cloudflare Quick Tunnel helper.
 *
 * Spawns `cloudflared tunnel --url <localUrl>` and captures the ephemeral
 * https://*.trycloudflare.com URL from its stderr. No account/domain needed.
 *
 * Quick Tunnels are explicitly for testing: URL changes every run, no SLA.
 * Production sellers must provide their own publicBaseUrl instead.
 */

import { spawn, type ChildProcess } from 'child_process';

export interface DemoTunnel {
  url: string;
  stop: () => void;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export function startQuickTunnel(localUrl: string, timeoutMs = 30000): Promise<DemoTunnel> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn('cloudflared', ['tunnel', '--url', localUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`cloudflared spawn failed: ${(err as Error).message}`));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`cloudflared did not report a tunnel URL within ${timeoutMs / 1000}s`));
      }
    }, timeoutMs);

    const onData = (buf: Buffer) => {
      const m = URL_RE.exec(buf.toString());
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: m[0], stop: () => child.kill() });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared not available: ${err.message} (install: brew install cloudflared)`));
      }
    });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared exited early (code ${code})`));
      }
    });
  });
}
