/**
 * x402 Seller — dashboard read API — read-only stats for the dashboard Seller tab.
 *
 * GET /api/seller/summary   — KPI tiles (earnings 30d + delta, calls, settle rate)
 * GET /api/seller/wallets   — payTo USDC.e balance + agent gas ETH
 * GET /api/seller/services  — configured services + per-service stats
 * GET /api/seller/jobs      — recent paid jobs (poll from the dashboard)
 * GET /api/seller/earnings  — daily settled series (sparkline)
 *
 * Read-only; balances are best-effort (RPC failure → null, never 500).
 */

import type { Express, Request, Response } from 'express';
import { JsonRpcProvider, Contract, formatEther } from 'ethers';
import type { SellerServiceEntry, X402SellerConfig } from './types';
import type { SellerLogger } from './deps';

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

export interface SellerApiDeps {
  db: {
    getSellerSummary(): { calls24h: number; callsTotal: number; settled24h: number; failed24h: number; earnings30d: string; earningsPrev30d: string };
    getSellerServiceStats(): Array<{ service: string; calls24h: number; callsTotal: number; earnings30d: string }>;
    getSellerJobs(limit?: number): unknown[];
    getSellerEarningsSeries(days?: number): Array<{ day: string; earnings: string }>;
  };
  getServices: () => SellerServiceEntry[];
  payTo: string;
  config: X402SellerConfig;
  /** RPC url for balance reads (chain.rpcUrl). Balances omitted when absent. */
  rpcUrl?: string;
  /** Agent gas EOA address (keystore), when available. */
  agentAddress?: string;
  log: SellerLogger;
}

export function mountSellerApi(app: Express, deps: SellerApiDeps): void {
  const provider = deps.rpcUrl ? new JsonRpcProvider(deps.rpcUrl) : undefined;
  // First configured asset = the USDC.e we quote prices in.
  const assetEntry = Object.values(deps.config.defaultAsset ?? {})[0];

  app.get('/api/seller/summary', (_req: Request, res: Response) => {
    try {
      const s = deps.db.getSellerSummary();
      const services = deps.getServices();
      res.json({
        ...s,
        settleSuccessRate24h: s.settled24h + s.failed24h > 0
          ? s.settled24h / (s.settled24h + s.failed24h) : null,
        activeServices: {
          total: services.length,
          direct: services.filter((x) => x.settlement === 'direct').length,
          onchain: services.filter((x) => x.settlement === 'onchain').length,
        },
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/seller/wallets', async (_req: Request, res: Response) => {
    const out: Record<string, unknown> = {
      payTo: { address: deps.payTo, usdce: null as string | null },
      gas: deps.agentAddress ? { address: deps.agentAddress, eth: null as string | null } : null,
    };
    if (provider) {
      try {
        if (assetEntry) {
          const usdce = new Contract(assetEntry.address, ERC20_ABI, provider);
          const bal: bigint = await usdce.balanceOf(deps.payTo);
          (out.payTo as any).usdce = bal.toString(); // atomic (6 dec)
        }
        if (deps.agentAddress) {
          (out.gas as any).eth = formatEther(await provider.getBalance(deps.agentAddress));
        }
      } catch (err) {
        deps.log.warn(`[x402-seller] wallet balance read failed: ${(err as Error).message}`);
      }
    }
    res.json(out);
  });

  app.get('/api/seller/services', (_req: Request, res: Response) => {
    try {
      const stats = new Map(deps.db.getSellerServiceStats().map((s) => [s.service, s]));
      res.json({
        services: deps.getServices().map((s) => ({
          name: s.name,
          containerId: s.containerId,
          settlement: s.settlement,
          network: s.network,
          price: s.x402Price,
          schemes: s.schemes,
          description: s.description,
          calls24h: stats.get(s.name)?.calls24h ?? 0,
          callsTotal: stats.get(s.name)?.callsTotal ?? 0,
          earnings30d: stats.get(s.name)?.earnings30d ?? '0',
        })),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/seller/jobs', (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit ?? '50'), 10) || 50;
      res.json({ jobs: deps.db.getSellerJobs(limit) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/seller/earnings', (req: Request, res: Response) => {
    try {
      const days = parseInt(String(req.query.days ?? '30'), 10) || 30;
      res.json({ series: deps.db.getSellerEarningsSeries(days) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
