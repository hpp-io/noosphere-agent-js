/**
 * x402 Seller — compute-failure classification for the HTTP/MCP surface.
 *
 * Both runners (agent-core ContainerManager and ExternalAwareRunner) report a
 * non-2xx container response as `Container HTTP error <status>: <body>`. A 4xx
 * from the container means the *buyer's input* was rejected (unfetchable
 * audio_url, undecodable media, …) — surface it as 400 with the container's
 * reason so the unpaid failure isn't a black box. Everything else is a
 * seller-side fault and stays opaque.
 *
 * The failure status must stay >=400 (serve-then-settle: the buyer is only
 * charged on <400). Seller-side faults use 500, not 502: Cloudflare replaces
 * origin 502/504 bodies with its branded HTML error page, so a 502 JSON body
 * never reaches the buyer.
 */

const CONTAINER_ERROR_RE = /^Container HTTP error (\d{3}): (.*)$/s;
const DETAIL_MAX = 300;

export interface ComputeFailure {
  status: 400 | 500;
  error: 'invalid_input' | 'compute_failed';
  detail?: string;
}

export function classifyComputeFailure(err: unknown): ComputeFailure {
  const message = err instanceof Error ? err.message : String(err);
  const match = CONTAINER_ERROR_RE.exec(message);
  if (match && Number(match[1]) < 500) {
    return { status: 400, error: 'invalid_input', detail: extractDetail(match[2]) };
  }
  return { status: 500, error: 'compute_failed' };
}

/** Container bodies are conventionally { error: string }; fall back to the raw text. */
function extractDetail(raw: string): string {
  let detail = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.error === 'string') detail = parsed.error;
  } catch {
    /* not JSON — keep raw */
  }
  detail = detail.trim();
  return detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail;
}
