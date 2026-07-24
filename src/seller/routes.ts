/**
 * x402 Seller — payment middleware + route wiring (M1, direct/exact).
 *
 * Builds the @x402/express payment middleware from the direct-settlement
 * services. M1 supports the `exact` (EIP-3009) scheme only; on-chain dispatch
 * and other schemes arrive in later milestones.
 */

import type { RequestHandler } from 'express';
import { paymentMiddlewareFromConfig } from '@x402/express';
import type { SchemeRegistration } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { RoutesConfig, FacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import type { Network } from '@x402/core/types';
import type { SellerServiceEntry, X402SellerAssetConfig } from './types';

export interface SellerMiddlewareOptions {
  payTo: string;
  /** Facilitator base URL per network (caip2). */
  facilitators: Record<string, string>;
  /** Default asset per network (caip2). */
  defaultAsset: Record<string, X402SellerAssetConfig>;
}

export interface SellerMiddlewareResult {
  middleware: RequestHandler;
  /** Route keys registered (for logging). */
  routeKeys: string[];
}

/**
 * Build the payment middleware for the given direct services.
 * Throws if a service references a network without a facilitator URL or asset.
 */
export function buildSellerMiddleware(
  directServices: SellerServiceEntry[],
  opts: SellerMiddlewareOptions,
): SellerMiddlewareResult {
  const networks = new Set(directServices.map((s) => s.network));

  const facilitatorClients: FacilitatorClient[] = [];
  const schemes: SchemeRegistration[] = [];
  const seenUrls = new Set<string>();

  for (const net of networks) {
    const url = opts.facilitators[net];
    if (!url) throw new Error(`x402Seller: no facilitator URL configured for network "${net}"`);
    if (!opts.defaultAsset[net]) throw new Error(`x402Seller: no defaultAsset configured for network "${net}"`);
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      facilitatorClients.push(new HTTPFacilitatorClient({ url }));
    }
    schemes.push({ network: net as Network, server: new ExactEvmScheme() });
  }

  const routes: RoutesConfig = {};
  for (const svc of directServices) {
    const asset = opts.defaultAsset[svc.network];
    (routes as Record<string, unknown>)[`POST /paid/compute/${svc.name}`] = {
      accepts: [
        {
          scheme: 'exact',
          network: svc.network as Network,
          payTo: opts.payTo,
          price: {
            amount: svc.x402Price,
            asset: asset.address,
            extra: { ...(asset.extra ?? {}) },
          },
          maxTimeoutSeconds: 600,
        },
      ],
      description: svc.description,
    };
  }

  const middleware = paymentMiddlewareFromConfig(routes, facilitatorClients, schemes);
  return { middleware, routeKeys: Object.keys(routes) };
}
