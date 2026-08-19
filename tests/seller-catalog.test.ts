import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { validateSellerConfig } from '../src/seller/catalog';
import { SellerService } from '../src/seller';
import type { X402SellerConfig } from '../src/seller/types';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function directSvc(over: Record<string, unknown> = {}) {
  return { name: 'llm', containerId: '0xabc', network: 'eip155:181228', x402Price: '10000', ...over };
}

describe('validateSellerConfig', () => {
  it('is inert when disabled or absent', () => {
    expect(validateSellerConfig(undefined)).toEqual({ services: [], errors: [] });
    expect(validateSellerConfig({ enabled: false, services: [directSvc()] })).toEqual({ services: [], errors: [] });
  });

  it('normalizes a valid direct service with defaults', () => {
    const cfg: X402SellerConfig = { enabled: true, services: [directSvc()] };
    const { services, errors } = validateSellerConfig(cfg);
    expect(errors).toEqual([]);
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      name: 'llm',
      containerId: '0xabc',
      settlement: 'direct', // default
      schemes: ['exact'],   // default
      x402Price: '10000',
    });
  });

  it('flags missing required fields', () => {
    const { errors } = validateSellerConfig({ enabled: true, services: [{ settlement: 'direct' }] });
    expect(errors.join('\n')).toMatch(/"name" is required/);
    expect(errors.join('\n')).toMatch(/"containerId" is required/);
    expect(errors.join('\n')).toMatch(/"network" is required/);
    expect(errors.join('\n')).toMatch(/"x402Price" is required/);
  });

  it('rejects non-atomic price', () => {
    const { errors } = validateSellerConfig({ enabled: true, services: [directSvc({ x402Price: '0.01' })] });
    expect(errors.join('\n')).toMatch(/must be an atomic integer string/);
  });

  it('rejects duplicate service names', () => {
    const { errors } = validateSellerConfig({ enabled: true, services: [directSvc(), directSvc()] });
    expect(errors.join('\n')).toMatch(/duplicate service name "llm"/);
  });

  it('rejects an unknown containerId when container ids are known', () => {
    const cfg: X402SellerConfig = { enabled: true, services: [directSvc({ containerId: '0xNOPE' })] };
    const { errors } = validateSellerConfig(cfg, { knownContainerIds: new Set(['0xabc']) });
    expect(errors.join('\n')).toMatch(/not declared in config.containers/);
  });

  it('accepts a known containerId', () => {
    const cfg: X402SellerConfig = { enabled: true, services: [directSvc()] };
    const { errors } = validateSellerConfig(cfg, { knownContainerIds: new Set(['0xabc']) });
    expect(errors).toEqual([]);
  });

  describe('onchain settlement', () => {
    it('requires feeAmount', () => {
      const { errors } = validateSellerConfig({ enabled: true, services: [directSvc({ settlement: 'onchain' })] });
      expect(errors.join('\n')).toMatch(/onchain settlement requires "feeAmount"/);
    });

    it('rejects feeAmount greater than x402Price', () => {
      const cfg: X402SellerConfig = { enabled: true, services: [directSvc({ settlement: 'onchain', feeAmount: '20000' })] };
      const { errors } = validateSellerConfig(cfg);
      expect(errors.join('\n')).toMatch(/must not exceed "x402Price"/);
    });

    it('accepts a valid onchain service', () => {
      const cfg: X402SellerConfig = {
        enabled: true,
        services: [directSvc({ settlement: 'onchain', feeAmount: '8000', verifier: '0x0', schemes: ['exact', 'batch-settlement'] })],
      };
      const { services, errors } = validateSellerConfig(cfg);
      expect(errors).toEqual([]);
      expect(services[0]).toMatchObject({ settlement: 'onchain', feeAmount: '8000', schemes: ['exact', 'batch-settlement'] });
    });
  });
});

describe('SellerService', () => {
  it('throws on invalid config during initialize()', async () => {
    const svc = new SellerService({ enabled: true, services: [{ name: 'x' }] }, { defaultPayTo: '0xpay', logger: noopLogger });
    await expect(svc.initialize()).rejects.toThrow(/x402Seller config invalid/);
  });

  it('throws when no payTo is resolvable', async () => {
    const svc = new SellerService({ enabled: true, services: [] }, { logger: noopLogger });
    await expect(svc.initialize()).rejects.toThrow(/no payTo address/);
  });

  it('falls back to defaultPayTo and exposes validated services', async () => {
    const svc = new SellerService(
      { enabled: true, services: [directSvc()] },
      { defaultPayTo: '0xpay', knownContainerIds: new Set(['0xabc']), logger: noopLogger },
    );
    await svc.initialize();
    expect(svc.payTo).toBe('0xpay');
    expect(svc.getServices()).toHaveLength(1);
    expect(svc.getServices()[0].name).toBe('llm');
  });

  it('prefers an explicit payTo over the default', async () => {
    const svc = new SellerService(
      { enabled: true, payTo: '0xexplicit', services: [] },
      { defaultPayTo: '0xpay', logger: noopLogger },
    );
    await svc.initialize();
    expect(svc.payTo).toBe('0xexplicit');
  });

  it('mount() throws before initialize()', () => {
    const svc = new SellerService({ enabled: true, services: [] }, { defaultPayTo: '0xpay', logger: noopLogger });
    expect(() => svc.mount(express())).toThrow(/before initialize/);
  });

  it('serves GET /paid/catalog with the validated services', async () => {
    const cfg: X402SellerConfig = {
      enabled: true,
      payTo: '0xexplicit',
      discovery: { enabled: true, url: 'https://x402-discovery.hpp.io' },
      services: [directSvc({ description: 'LLM inference' })],
    };
    const svc = new SellerService(cfg, { knownContainerIds: new Set(['0xabc']), logger: noopLogger });
    await svc.initialize();

    const app = express();
    svc.mount(app);

    const res = await request(app).get('/paid/catalog');
    expect(res.status).toBe(200);
    expect(res.body.payTo).toBe('0xexplicit');
    expect(res.body.discovery).toBe('https://x402-discovery.hpp.io');
    expect(res.body.services).toHaveLength(1);
    expect(res.body.services[0]).toMatchObject({
      name: 'llm',
      settlement: 'direct',
      network: 'eip155:181228',
      price: '10000',
      schemes: ['exact'],
      description: 'LLM inference',
    });
  });
});

describe('upto scheme + maxTimeoutSeconds (async job services)', () => {
  it('carries maxTimeoutSeconds through validation', async () => {
    const { validateSellerConfig } = await import('../src/seller/catalog');
    const { services, errors } = validateSellerConfig({
      enabled: true, payTo: '0x' + '1'.repeat(40),
      services: [{ name: 'stt-longform', containerId: 'hf-stt', settlement: 'direct',
        network: 'eip155:190415', schemes: ['upto'], x402Price: '360000', maxTimeoutSeconds: 10800 }],
    } as never, {});
    expect(errors).toEqual([]);
    expect(services[0].schemes).toEqual(['upto']);
    expect(services[0].maxTimeoutSeconds).toBe(10800);
  });

  it('rejects a non-positive maxTimeoutSeconds', async () => {
    const { validateSellerConfig } = await import('../src/seller/catalog');
    const { errors } = validateSellerConfig({
      enabled: true, payTo: '0x' + '1'.repeat(40),
      services: [{ name: 's', containerId: 'c', settlement: 'direct',
        network: 'eip155:190415', schemes: ['exact'], x402Price: '1', maxTimeoutSeconds: 0 }],
    } as never, {});
    expect(errors.join()).toContain('maxTimeoutSeconds');
  });

  it('advertises one accept per scheme with the service window', async () => {
    const { buildSellerRoutes } = await import('../src/seller/routes');
    const routes: any = buildSellerRoutes(
      [{ name: 'stt-longform', containerId: 'hf-stt', settlement: 'direct',
         network: 'eip155:190415', schemes: ['upto', 'exact'], x402Price: '360000',
         maxTimeoutSeconds: 10800 } as never],
      { payTo: '0xPay', facilitators: { 'eip155:190415': 'https://f' },
        defaultAsset: { 'eip155:190415': { address: '0xA' } } },
    );
    const accepts = routes['POST /paid/compute/stt-longform'].accepts;
    expect(accepts.map((a: any) => a.scheme)).toEqual(['upto', 'exact']);
    expect(accepts.every((a: any) => a.maxTimeoutSeconds === 10800)).toBe(true);
  });
});
