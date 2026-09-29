/**
 * Facilitator client that survives a dropped connection.
 *
 * `HTTPFacilitatorClient.verify()`/`settle()` call `fetch` once, with no timeout and no retry
 * (only `getSupported()` retries, and only on HTTP 429). So a single transport hiccup — a keep-alive
 * socket the edge closed while the agent was idle, a reset, a DNS blip — surfaces to the buyer as
 * `402 … "fetch failed"`, and for receipt services the work is already done: the container has run,
 * the payment is not captured, and the job is recorded `settle_failed`.
 *
 * Observed on HPP Sepolia (2026-09-29): roughly one payment in four failed this way. The facilitator
 * never saw those requests — its `settle_failures` counter stayed at 0 and no transfer reached the
 * chain — so the call died before arrival and retrying is the right answer.
 *
 * Only transport failures are retried. An HTTP response, whatever its status, is a decision by the
 * facilitator and is passed through untouched. Retrying a settle is safe even in the race where the
 * first attempt did arrive: the EIP-3009 authorization carries a nonce that the token marks used, so
 * a duplicate settlement reverts on-chain instead of charging twice.
 */
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { FacilitatorClient } from '@x402/core/server';

/** Transport failure (`fetch` threw) rather than an HTTP response. */
export function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // undici surfaces every network fault as TypeError('fetch failed') with the real code on `cause`.
  if (err.name === 'TypeError') return true;
  const code = String((err as { cause?: { code?: string } }).cause?.code ?? '');
  return /^(UND_ERR|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)/.test(code);
}

const describe = (err: unknown): string => {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
};

export interface RetryOptions {
  /** Extra attempts after the first (default 2). */
  retries?: number;
  /** Delay before the first retry in ms; doubles after that (default 300). */
  baseDelayMs?: number;
  log?: { warn(msg: string): void };
}

/** Run `fn`, retrying only when the call never produced an HTTP response. */
export async function withTransportRetry<T>(op: string, fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransportError(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      opts.log?.warn(
        `[x402-seller] facilitator ${op} transport error (${describe(err)}); retry ${attempt + 1}/${retries} in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export class RetryingFacilitatorClient implements FacilitatorClient {
  /** Injectable so tests can drive the retry rules without a network. */
  constructor(
    config: { url: string },
    private readonly opts: RetryOptions = {},
    private readonly inner: FacilitatorClient = new HTTPFacilitatorClient(config),
  ) {}

  verify: FacilitatorClient['verify'] = (payload, requirements) =>
    withTransportRetry('verify', () => this.inner.verify(payload, requirements), this.opts);

  settle: FacilitatorClient['settle'] = (payload, requirements) =>
    withTransportRetry('settle', () => this.inner.settle(payload, requirements), this.opts);

  getSupported: FacilitatorClient['getSupported'] = () =>
    withTransportRetry('supported', () => this.inner.getSupported(), this.opts);
}
