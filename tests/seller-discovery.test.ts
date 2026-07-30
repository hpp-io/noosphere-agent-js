import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Wallet, verifyMessage } from 'ethers';
import { buildSellerRoutes } from '../src/seller/routes';
import { DiscoveryClient } from '../src/seller/discovery';
import { SellerService } from '../src/seller';
import type { SellerServiceEntry } from '../src/seller/types';

// @x402 2.14 uses the short key 'bazaar' (later SDKs use the full extension URL).
const BAZAAR_KEY = 'bazaar';
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const svc = (over: Partial<SellerServiceEntry> = {}): SellerServiceEntry => ({
  name: 'sentiment', containerId: 'hf-sentiment', settlement: 'direct',
  network: 'eip155:181228', x402Price: '5000', schemes: ['exact'],
  inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  description: 'Sentiment analysis',
  ...over,
});

const mwOpts = {
  payTo: '0xPay',
  facilitators: { 'eip155:181228': 'https://facilitator-sepolia.hpp.io' },
  defaultAsset: { 'eip155:181228': { address: '0xUSDCe', extra: { name: 'Bridged USDC', version: '2' } } },
};

describe('buildSellerRoutes — bazaar discovery extension (M5-a)', () => {
  it('declares the bazaar extension on each paid route', () => {
    const routes: any = buildSellerRoutes([svc({ discovery: { input: { text: 'hi' }, output: { example: { output: 'POSITIVE' } } } })], mwOpts);
    const route = routes['POST /paid/compute/sentiment'];
    expect(route).toBeTruthy();
    expect(route.extensions).toBeTruthy();
    expect(Object.keys(route.extensions)).toContain(BAZAAR_KEY);
    const ext = route.extensions[BAZAAR_KEY];
    const info = ext.info ?? ext;
    const flat = JSON.stringify(ext);
    expect(flat).toContain('json');          // bodyType
    expect(flat).toContain('POSITIVE');      // output example
    expect(flat).toContain('"text"');        // inputSchema carried
    expect(info).toBeTruthy();
  });

  it('falls back to a generic output example + permissive schema', () => {
    const bare = svc(); delete (bare as any).inputSchema;
    const routes: any = buildSellerRoutes([bare], mwOpts);
    const flat = JSON.stringify(routes['POST /paid/compute/sentiment'].extensions[BAZAAR_KEY]);
    expect(flat).toContain('jobId');
  });
});

describe('DiscoveryClient (M5-b)', () => {
  const wallet = Wallet.createRandom();
  const signer = { address: wallet.address, signMessage: (m: string) => wallet.signMessage(m) };

  function mockFetch(handlers: Record<string, (body: any) => { status: number; json: any }>) {
    return vi.fn(async (url: any, init?: any) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      const h = handlers[path];
      if (!h) return { status: 404, json: async () => ({ error: 'no route' }) } as any;
      const out = h(init?.body ? JSON.parse(init.body) : {});
      return { status: out.status, json: async () => out.json } as any;
    });
  }

  it('challenge → sign(payTo) → register with the listing fields (http only by default)', async () => {
    const seen: any = { registers: [] };
    const fetchImpl = mockFetch({
      '/listings/challenge': (b) => {
        seen.challenge = b;
        return { status: 200, json: { nonce: 'n-1', message: `own ${b.payTo} nonce n-1`, expiresAt: 'later' } };
      },
      '/listings/register': (b) => {
        seen.registers.push(b);
        return { status: 201, json: { id: 'r-1', listingState: 'pending' } };
      },
    });
    const client = new DiscoveryClient({ apiUrl: 'http://disc.local', fetchImpl: fetchImpl as any });
    const res = await client.register({
      service: svc(), publicBaseUrl: 'https://seller.example.com/', asset: '0xUSDCe', signer,
    });

    expect(res).toHaveLength(1); // no mcp requested
    expect(res[0]).toMatchObject({ ok: true, transport: 'http', state: 'pending' });
    expect(seen.challenge).toMatchObject({ payTo: wallet.address, action: 'register' });
    expect(seen.registers[0]).toMatchObject({
      type: 'http',
      resourceUrl: 'https://seller.example.com/paid/compute/sentiment', // trailing slash normalized
      httpMethod: 'POST',
      bodyType: 'json',
      network: 'eip155:181228',
      asset: '0xUSDCe',
      priceAtomic: '5000',
      scheme: 'exact',
      nonce: 'n-1',
    });
    expect(seen.registers[0].toolName).toBeUndefined();
    expect(seen.registers[0].serviceName).toBe('sentiment'); // falls back to service name
    // The signature must recover to payTo — discovery's ownership check.
    expect(verifyMessage(`own ${wallet.address} nonce n-1`, seen.registers[0].signature)).toBe(wallet.address);
  });

  it('forwards serviceName, tags and iconUrl from discovery metadata', async () => {
    const registers: any[] = [];
    const fetchImpl = mockFetch({
      '/listings/challenge': (b) => ({ status: 200, json: { nonce: 'n', message: `own ${b.payTo} nonce n` } }),
      '/listings/register': (b) => { registers.push(b); return { status: 201, json: { listingState: 'pending' } }; },
    });
    const client = new DiscoveryClient({ apiUrl: 'http://disc.local', fetchImpl: fetchImpl as any });
    const withMeta = svc({ discovery: { serviceName: 'Sentiment (SST-2)', tags: ['nlp', 'sentiment'], iconUrl: 'https://x/i.png' } });
    const res = await client.register({ service: withMeta, publicBaseUrl: 'https://s.example.com', asset: '0xUSDCe', signer, mcp: true });

    expect(res.every((r) => r.ok)).toBe(true);
    for (const reg of registers) { // both http and mcp carry the metadata
      expect(reg.serviceName).toBe('Sentiment (SST-2)');
      expect(reg.tags).toEqual(['nlp', 'sentiment']);
      expect(reg.iconUrl).toBe('https://x/i.png');
    }
  });

  it('registers an mcp listing alongside http when mcp:true', async () => {
    const registers: any[] = [];
    const fetchImpl = mockFetch({
      '/listings/challenge': (b) => ({ status: 200, json: { nonce: 'n', message: `own ${b.payTo} nonce n` } }),
      '/listings/register': (b) => { registers.push(b); return { status: 201, json: { listingState: 'pending' } }; },
    });
    const client = new DiscoveryClient({ apiUrl: 'http://disc.local', fetchImpl: fetchImpl as any });
    const res = await client.register({
      service: svc(), publicBaseUrl: 'https://seller.example.com', asset: '0xUSDCe', signer, mcp: true,
    });

    expect(res.map((r) => r.transport)).toEqual(['http', 'mcp']);
    expect(res.every((r) => r.ok)).toBe(true);
    const mcp = registers.find((r) => r.type === 'mcp');
    expect(mcp).toMatchObject({
      type: 'mcp',
      // Must equal the x402 resource the MCP 402 advertises (per-tool URL),
      // not the bare /mcp server root — otherwise settlements never match this
      // listing and discovery files each as a pending phantom.
      resourceUrl: 'https://seller.example.com/mcp/tools/compute_sentiment',
      toolName: 'compute_sentiment',
      transport: 'streamable-http',
      network: 'eip155:181228',
      priceAtomic: '5000',
      scheme: 'exact',
    });
    expect(mcp.httpMethod).toBeUndefined(); // discovery rejects httpMethod on mcp listings
  });

  it('retries on the register 429 rate limit (fresh challenge each time), then succeeds', async () => {
    const challenges: any[] = [];
    let registerCalls = 0;
    const fetchImpl = mockFetch({
      '/listings/challenge': (b) => { challenges.push(b); return { status: 200, json: { nonce: `n-${challenges.length}`, message: `own ${b.payTo} nonce n-${challenges.length}` } }; },
      '/listings/register': () => {
        registerCalls += 1;
        return registerCalls < 3 ? { status: 429, json: { error: 'register rate limit' } } : { status: 201, json: { listingState: 'pending' } };
      },
    });
    const sleeps: number[] = [];
    const client = new DiscoveryClient({
      apiUrl: 'http://disc.local', fetchImpl: fetchImpl as any,
      rateLimitRetry: { attempts: 5, delayMs: 1 }, sleepImpl: async (ms) => { sleeps.push(ms); },
    });
    const res = await client.register({ service: svc(), publicBaseUrl: 'http://x', asset: '0xA', signer });

    expect(res[0].ok).toBe(true);
    expect(registerCalls).toBe(3);          // 2×429 + 1×201
    expect(challenges).toHaveLength(3);      // re-challenged each retry (nonce burned on 429)
    expect(sleeps).toEqual([1, 1]);         // backed off twice
  });

  it('returns ok=false (never throws) on non-retryable challenge failure', async () => {
    const fetchImpl = mockFetch({ '/listings/challenge': () => ({ status: 500, json: { error: 'boom' } }) });
    const client = new DiscoveryClient({ apiUrl: 'http://disc.local', fetchImpl: fetchImpl as any, rateLimitRetry: { attempts: 0 } });
    const res = await client.register({ service: svc(), publicBaseUrl: 'http://x', asset: '0xA', signer });
    expect(res[0].ok).toBe(false);
    expect(res[0].status).toBe(500);
  });
});

describe('SellerService.announce (M5 wiring + P1-1 payTo policy)', () => {
  const wallet = Wallet.createRandom();
  const baseCfg = {
    enabled: true,
    payTo: wallet.address,
    defaultAsset: { 'eip155:181228': { address: '0xUSDCe' } },
    discovery: { enabled: true, apiUrl: 'http://disc.local', publicBaseUrl: 'https://pub.example.com', register: true },
    services: [svc()],
  };
  let warns: string[];
  const logger = { info: () => {}, error: () => {}, warn: (m: string) => { warns.push(m); } };

  beforeEach(() => { warns = []; });
  afterEach(() => vi.unstubAllGlobals());

  it('registers when signer matches payTo', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
      calls.push(String(url));
      if (String(url).endsWith('/challenge')) return { status: 200, json: async () => ({ nonce: 'n', message: 'm' }) } as any;
      return { status: 201, json: async () => ({ listingState: 'pending' }) } as any;
    }));
    const s = new SellerService(baseCfg as any, {
      knownContainerIds: new Set(['hf-sentiment']),
      signer: { address: wallet.address, signMessage: (m: string) => wallet.signMessage(m) },
      logger,
    });
    await s.initialize();
    await s.announce();
    expect(calls.some((u) => u.endsWith('/listings/challenge'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/listings/register'))).toBe(true);
  });

  it('warns and skips registration when payTo is not the signer EOA', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const other = Wallet.createRandom();
    const s = new SellerService(baseCfg as any, {
      knownContainerIds: new Set(['hf-sentiment']),
      signer: { address: other.address, signMessage: (m: string) => other.signMessage(m) },
      logger,
    });
    await s.initialize();
    await s.announce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warns.join(' ')).toMatch(/not the agent signer EOA/);
  });

  it('demo tunnel URL overrides publicBaseUrl', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
      if (String(url).endsWith('/challenge')) return { status: 200, json: async () => ({ nonce: 'n', message: 'm' }) } as any;
      urls.push(init?.body ? JSON.parse(init.body).resourceUrl : '');
      return { status: 201, json: async () => ({}) } as any;
    }));
    const stop = vi.fn();
    const s = new SellerService({ ...baseCfg, demoTunnel: true } as any, {
      knownContainerIds: new Set(['hf-sentiment']),
      signer: { address: wallet.address, signMessage: (m: string) => wallet.signMessage(m) },
      startTunnel: async () => ({ url: 'https://rand.trycloudflare.com', stop }),
      port: 4077,
      logger,
    });
    await s.initialize();
    await s.announce();
    expect(urls[0]).toBe('https://rand.trycloudflare.com/paid/compute/sentiment');
    s.shutdown();
    expect(stop).toHaveBeenCalled();
  });

  it('warns when register requested but no publicBaseUrl resolvable', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const cfg = { ...baseCfg, discovery: { ...baseCfg.discovery, publicBaseUrl: undefined } };
    const s = new SellerService(cfg as any, {
      knownContainerIds: new Set(['hf-sentiment']),
      signer: { address: wallet.address, signMessage: (m: string) => wallet.signMessage(m) },
      logger,
    });
    await s.initialize();
    await s.announce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warns.join(' ')).toMatch(/no publicBaseUrl/);
  });
});
