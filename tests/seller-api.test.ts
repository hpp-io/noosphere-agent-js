import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mountSellerApi } from '../src/seller/api';
import { getDatabase } from '../lib/db';
import type { SellerServiceEntry } from '../src/seller/types';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const services: SellerServiceEntry[] = [
  { name: 'llm', containerId: '0xabc', settlement: 'direct', network: 'eip155:181228', x402Price: '10000', schemes: ['exact'] },
  { name: 'verified', containerId: '0xdef', settlement: 'onchain', network: 'eip155:181228', x402Price: '20000', schemes: ['exact'], feeAmount: '8000' },
];

const stubDb = {
  getSellerSummary: () => ({ calls24h: 5, callsTotal: 42, settled24h: 4, failed24h: 1, earnings30d: '50000', earningsPrev30d: '40000' }),
  getSellerServiceStats: () => [{ service: 'llm', calls24h: 5, callsTotal: 40, earnings30d: '50000' }],
  getSellerJobs: (limit?: number) => [{ job_id: 'j1', service: 'llm', status: 'settled', amount: '10000' }].slice(0, limit),
  getSellerEarningsSeries: () => [{ day: '2026-07-23', earnings: '20000' }, { day: '2026-07-24', earnings: '30000' }],
};

function makeApp() {
  const app = express();
  mountSellerApi(app, {
    db: stubDb as any,
    getServices: () => services,
    payTo: '0xPayTo',
    config: { enabled: true } as any, // no defaultAsset/rpc → balances omitted
    log: noopLogger,
  });
  return app;
}

describe('seller dashboard API (M5-c)', () => {
  it('GET /api/seller/summary aggregates + settle rate + service counts', async () => {
    const res = await request(makeApp()).get('/api/seller/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      calls24h: 5, callsTotal: 42, earnings30d: '50000',
      activeServices: { total: 2, direct: 1, onchain: 1 },
    });
    expect(res.body.settleSuccessRate24h).toBeCloseTo(0.8);
  });

  it('GET /api/seller/services merges config with per-service stats', async () => {
    const res = await request(makeApp()).get('/api/seller/services');
    expect(res.status).toBe(200);
    const llm = res.body.services.find((s: any) => s.name === 'llm');
    expect(llm).toMatchObject({ settlement: 'direct', price: '10000', calls24h: 5, earnings30d: '50000' });
    const verified = res.body.services.find((s: any) => s.name === 'verified');
    expect(verified).toMatchObject({ settlement: 'onchain', calls24h: 0, earnings30d: '0' }); // no stats row → zeros
  });

  it('GET /api/seller/jobs respects limit', async () => {
    const res = await request(makeApp()).get('/api/seller/jobs?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
  });

  it('GET /api/seller/earnings returns the daily series', async () => {
    const res = await request(makeApp()).get('/api/seller/earnings');
    expect(res.status).toBe(200);
    expect(res.body.series).toHaveLength(2);
  });

  it('GET /api/seller/wallets works without rpc (null balances)', async () => {
    const res = await request(makeApp()).get('/api/seller/wallets');
    expect(res.status).toBe(200);
    expect(res.body.payTo).toEqual({ address: '0xPayTo', usdce: null });
    expect(res.body.gas).toBeNull(); // no agentAddress
  });
});

describe('AgentDatabase seller aggregates (M5-c)', () => {
  it('summary/serviceStats/series run and are consistent with inserted rows', () => {
    const db = getDatabase();
    const id = `api-test-${Date.now()}`;
    db.saveSellerJob({ job_id: id, service: 'api-test-svc', settlement: 'direct', amount: '7000', status: 'running' });
    db.updateSellerJob(id, { status: 'settled', settle_tx: '0xtx' });

    const summary = db.getSellerSummary();
    expect(summary.calls24h).toBeGreaterThanOrEqual(1);
    expect(BigInt(summary.earnings30d)).toBeGreaterThanOrEqual(7000n);

    const stats = db.getSellerServiceStats().find((s) => s.service === 'api-test-svc');
    expect(stats).toBeTruthy();
    expect(BigInt(stats!.earnings30d)).toBeGreaterThanOrEqual(7000n);

    const series = db.getSellerEarningsSeries(30);
    expect(series.length).toBeGreaterThanOrEqual(1);
    expect(series.every((r) => /^\d+$/.test(r.earnings))).toBe(true);
  });
});
