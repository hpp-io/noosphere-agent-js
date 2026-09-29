import { describe, it, expect } from 'vitest';
import { RetryingFacilitatorClient, isTransportError, withTransportRetry } from '../src/seller/facilitator-client';
import type { FacilitatorClient } from '@x402/core/server';

// 전송 실패(fetch throw)만 재시도하고, facilitator 의 HTTP 응답은 그대로 통과시키는지.
// 회귀 대상: settle 한 번 끊겼다고 구매자에게 402 "fetch failed" 가 나가던 문제(2026-09-29).
const fetchFailed = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });
const settleOk = { success: true, transaction: '0xabc' };

/** 호출 횟수를 세는 스텁 facilitator */
function stub(impl: () => Promise<unknown>) {
  const calls = { n: 0 };
  const client = {
    verify: () => { calls.n++; return impl(); },
    settle: () => { calls.n++; return impl(); },
    getSupported: () => { calls.n++; return impl(); },
  } as unknown as FacilitatorClient;
  return { client, calls };
}
const mk = (impl: () => Promise<unknown>) => {
  const { client, calls } = stub(impl);
  return { c: new RetryingFacilitatorClient({ url: 'https://f.example' }, { baseDelayMs: 1 }, client), calls };
};

describe('isTransportError', () => {
  it('true for a thrown fetch (no HTTP response)', () => {
    expect(isTransportError(fetchFailed())).toBe(true);
    expect(isTransportError(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
  });
  it('false for a facilitator decision surfaced as an Error', () => {
    expect(isTransportError(new Error('Facilitator settle failed (400): invalid_request'))).toBe(false);
  });
});

describe('withTransportRetry', () => {
  it('stops at the configured number of attempts', async () => {
    let n = 0;
    await expect(withTransportRetry('settle', async () => { n++; throw fetchFailed(); }, { retries: 2, baseDelayMs: 1 }))
      .rejects.toThrow('fetch failed');
    expect(n).toBe(3);   // 최초 1 + 재시도 2
  });
  it('logs each retry', async () => {
    const lines: string[] = [];
    let n = 0;
    await withTransportRetry('settle', async () => { if (++n === 1) throw fetchFailed(); return 'ok'; },
      { baseDelayMs: 1, log: { warn: (m) => lines.push(m) } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('UND_ERR_SOCKET');
  });
});

describe('RetryingFacilitatorClient', () => {
  it('retries settle on a transport error and succeeds', async () => {
    let n = 0;
    const { c, calls } = mk(async () => { if (++n === 1) throw fetchFailed(); return settleOk; });
    await expect(c.settle({} as never, {} as never)).resolves.toEqual(settleOk);
    expect(calls.n).toBe(2);
  });
  it('does not retry a facilitator decision', async () => {
    const { c, calls } = mk(async () => { throw new Error('Facilitator settle failed (400): invalid_request'); });
    await expect(c.settle({} as never, {} as never)).rejects.toThrow('invalid_request');
    expect(calls.n).toBe(1);
  });
  it('covers verify as well', async () => {
    let n = 0;
    const { c, calls } = mk(async () => { if (++n === 1) throw fetchFailed(); return { isValid: true }; });
    await expect(c.verify({} as never, {} as never)).resolves.toEqual({ isValid: true });
    expect(calls.n).toBe(2);
  });
});
