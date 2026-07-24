import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mountSellerMcp } from '../src/seller/mcp';
import type { SellerServiceEntry } from '../src/seller/types';
import type { ContainerMeta } from '../src/seller/deps';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const svc: SellerServiceEntry = {
  name: 'sentiment', containerId: 'hf', settlement: 'direct',
  network: 'eip155:181228', x402Price: '1000', schemes: ['exact'],
  inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  description: 'Sentiment analysis, paid per call',
};
const container: ContainerMeta = { id: 'hf', name: 'hf', image: 'img', tag: 'latest', port: '8090' };

describe('mountSellerMcp (M3)', () => {
  let facilitator: Server;
  let seller: Server;
  let sellerUrl: string;
  const db = {
    saveSellerJob: vi.fn(), updateSellerJob: vi.fn(),
    getSellerJobs: () => [], getSellerEarnings: () => [],
    getSellerSummary: () => ({ calls24h: 0, callsTotal: 0, settled24h: 0, failed24h: 0, earnings30d: '0', earningsPrev30d: '0' }),
    getSellerServiceStats: () => [], getSellerEarningsSeries: () => [],
  };

  beforeAll(async () => {
    // Stub facilitator: only /supported is needed for tool preparation.
    const fac = express();
    fac.get('/supported', (_req, res) => {
      res.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:181228' }] });
    });
    facilitator = fac.listen(0);
    const facPort = (facilitator.address() as any).port;

    const app = express();
    app.use(express.json());
    const runner = { runContainer: vi.fn().mockResolvedValue({ output: 'POSITIVE (0.98)' }) };
    const { tools } = await mountSellerMcp({
      app,
      services: [svc],
      containers: new Map([['hf', container]]),
      runner,
      db: db as any,
      log: noopLogger,
      payTo: '0xPayTo',
      facilitators: { 'eip155:181228': `http://localhost:${facPort}` },
      defaultAsset: { 'eip155:181228': { address: '0xUSDCe', extra: { name: 'Bridged USDC', version: '2' } } },
    });
    expect(tools).toEqual(['compute_sentiment']);

    seller = app.listen(0);
    sellerUrl = `http://localhost:${(seller.address() as any).port}/mcp`;
  });

  afterAll(() => {
    seller?.close();
    facilitator?.close();
  });

  async function connect() {
    const client = new Client({ name: 'test-buyer', version: '0.0.1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(sellerUrl)));
    return client;
  }

  it('lists compute_<svc> tools over StreamableHTTP', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'compute_sentiment');
    expect(tool).toBeTruthy();
    expect(tool!.description).toMatch(/Sentiment analysis/);
    await client.close();
  });

  it('unpaid tool call returns a payment-required error (no compute, no charge)', async () => {
    const client = await connect();
    const res: any = await client.callTool({ name: 'compute_sentiment', arguments: { args: { text: 'hi' } } });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text.toLowerCase()).toMatch(/payment/);
    // Handler never ran: no job saved, container not invoked.
    expect(db.saveSellerJob).not.toHaveBeenCalled();
    await client.close();
  });
});
