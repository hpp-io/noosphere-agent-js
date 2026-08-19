import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { buildSellerMiddleware } from '../src/seller/routes';
import { makeDirectHandler } from '../src/seller/settlement/direct';
import { getDatabase } from '../lib/db';
import type { SellerServiceEntry } from '../src/seller/types';
import type { ContainerMeta } from '../src/seller/deps';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const svc = (over: Partial<SellerServiceEntry> = {}): SellerServiceEntry => ({
  name: 'llm',
  containerId: '0xabc',
  settlement: 'direct',
  network: 'eip155:181228',
  x402Price: '10000',
  schemes: ['exact'],
  ...over,
});

const asset = { 'eip155:181228': { address: '0xUSDCe', extra: { name: 'Bridged USDC', version: '2' } } };
const facilitators = { 'eip155:181228': 'https://facilitator-sepolia.hpp.io' };

describe('buildSellerMiddleware', () => {
  it('builds middleware and route keys for direct services', () => {
    const { middleware, routeKeys } = buildSellerMiddleware([svc()], {
      payTo: '0xpay', facilitators, defaultAsset: asset,
    });
    expect(typeof middleware).toBe('function');
    expect(routeKeys).toEqual(['POST /paid/compute/llm']);
  });

  it('throws when a network has no facilitator URL', () => {
    expect(() => buildSellerMiddleware([svc()], { payTo: '0xpay', facilitators: {}, defaultAsset: asset }))
      .toThrow(/no facilitator URL/);
  });

  it('throws when a network has no defaultAsset', () => {
    expect(() => buildSellerMiddleware([svc()], { payTo: '0xpay', facilitators, defaultAsset: {} }))
      .toThrow(/no defaultAsset/);
  });
});

// Minimal Express-like response mock that emits 'finish' when the body is sent.
function mockRes(preHeaders: Record<string, string> = {}) {
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.headers = { ...preHeaders };
  res.body = undefined;
  res.status = function (c: number) { res.statusCode = c; return res; };
  res.json = function (b: unknown) { res.body = b; res.emit('finish'); return res; };
  res.getHeader = function (n: string) { return res.headers[n.toLowerCase()]; };
  res.setHeader = function (n: string, v: string) { res.headers[n.toLowerCase()] = v; };
  return res;
}

function mockReq(body: unknown, headers: Record<string, string> = {}) {
  return {
    body,
    header: (n: string) => headers[n.toLowerCase()],
  } as any;
}

const container: ContainerMeta = { id: '0xabc', name: 'llm', image: 'img', tag: 'latest', port: '8082' };

describe('makeDirectHandler', () => {
  let db: { saveSellerJob: any; updateSellerJob: any };

  beforeEach(() => {
    db = { saveSellerJob: vi.fn(), updateSellerJob: vi.fn() };
  });

  it('runs the container, returns output, records completed → settled', async () => {
    const runner = { runContainer: vi.fn().mockResolvedValue({ output: 'hi there' }) };
    const handler = makeDirectHandler(svc(), { runner, container, db: db as any, log: noopLogger, asset: '0xUSDCe' });

    // Simulate the middleware having settled: PAYMENT-RESPONSE present at finish.
    const settleHeader = Buffer.from(JSON.stringify({ success: true, transaction: '0xdeadbeef' })).toString('base64');
    const res = mockRes({ 'payment-response': settleHeader });
    const payment = Buffer.from(JSON.stringify({ scheme: 'exact', payload: { authorization: { from: '0xPayer' } } })).toString('base64');

    await handler(mockReq({ prompt: 'hi' }, { 'x-payment': payment }), res);

    expect(runner.runContainer).toHaveBeenCalledWith(container, JSON.stringify({ prompt: 'hi' }), undefined);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ service: 'llm', output: 'hi there' });

    // saved as running with payer/scheme extracted from X-PAYMENT
    expect(db.saveSellerJob).toHaveBeenCalledWith(expect.objectContaining({
      service: 'llm', settlement: 'direct', status: 'running', payer: '0xPayer', scheme: 'exact', amount: '10000',
    }));
    // completed, then settled from the PAYMENT-RESPONSE header
    const statuses = db.updateSellerJob.mock.calls.map((c: any[]) => c[1].status);
    expect(statuses).toContain('completed');
    expect(statuses).toContain('settled');
    const settled = db.updateSellerJob.mock.calls.find((c: any[]) => c[1].status === 'settled');
    expect(settled[1].settle_tx).toBe('0xdeadbeef');
  });

  it('returns 502 and records failed (no settle) when compute fails', async () => {
    const runner = { runContainer: vi.fn().mockRejectedValue(new Error('container down')) };
    const handler = makeDirectHandler(svc(), { runner, container, db: db as any, log: noopLogger });
    const res = mockRes();

    await handler(mockReq({ prompt: 'x' }), res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: 'compute_failed' });
    const statuses = db.updateSellerJob.mock.calls.map((c: any[]) => c[1].status);
    expect(statuses).toContain('failed');
    expect(statuses).not.toContain('settled');
  });
});

describe('AgentDatabase seller_jobs', () => {
  it('saves, updates, lists and aggregates earnings', () => {
    const db = getDatabase();
    const id = `test-job-${Date.now()}`;

    db.saveSellerJob({ job_id: id, service: 'llm', settlement: 'direct', network: 'eip155:181228', amount: '10000', status: 'running' });
    db.updateSellerJob(id, { status: 'settled', settle_tx: '0xabc', output: 'ok' });

    const jobs = db.getSellerJobs(10);
    const row = jobs.find((j) => j.job_id === id);
    expect(row).toBeTruthy();
    expect(row!.status).toBe('settled');
    expect(row!.settle_tx).toBe('0xabc');
    expect(row!.output).toBe('ok');

    const earnings = db.getSellerEarnings();
    const llm = earnings.find((e) => e.service === 'llm');
    expect(llm).toBeTruthy();
    expect(BigInt(llm!.earnings)).toBeGreaterThanOrEqual(10000n);
  });

  it('caps stored output so multi-MB media payloads do not bloat the db', () => {
    const db = getDatabase();
    const id = `test-job-cap-${Date.now()}`;
    const big = 'a'.repeat(5 * 1024 * 1024); // ~5MB, like a base64 TTS wav

    db.saveSellerJob({ job_id: id, service: 'tts', settlement: 'direct', status: 'running' });
    db.updateSellerJob(id, { status: 'completed', output: big });

    const row = db.getSellerJobs(10).find((j) => j.job_id === id);
    expect(row).toBeTruthy();
    expect(row!.output!.length).toBeLessThan(20 * 1024);
    expect(row!.output).toContain(`…[truncated: ${5 * 1024 * 1024} bytes total]`);

    // small outputs stay verbatim
    db.updateSellerJob(id, { output: 'small' });
    expect(db.getSellerJobs(10).find((j) => j.job_id === id)!.output).toBe('small');
  });
});
