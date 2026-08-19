/**
 * x402 Seller — payment middleware + route wiring (direct settlement, exact scheme).
 *
 * Builds the @x402/express payment middleware from the direct-settlement
 * services. Currently the `exact` (EIP-3009) scheme is supported; on-chain dispatch
 * and other schemes arrive in later milestones.
 */

import type { RequestHandler } from 'express';
import { paymentMiddlewareFromConfig, x402ResourceServer, x402HTTPResourceServer } from '@x402/express';
import type { SchemeRegistration } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { RoutesConfig, FacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { UptoEvmScheme } from '@x402/evm/upto/server';
import type { Network } from '@x402/core/types';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
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
 * Synthesize a minimal example object satisfying a JSON-schema subset
 * (object/required/properties with primitive types). Used when the seller
 * declares an inputSchema but no discovery example input.
 */
export function synthesizeExample(schema?: Record<string, unknown>): Record<string, unknown> {
  if (!schema || schema.type !== 'object') return {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const props = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
  const out: Record<string, unknown> = {};
  for (const key of required) {
    const p = props[key] ?? {};
    if (Array.isArray(p.enum) && p.enum.length > 0) out[key] = p.enum[0];
    else if (p.type === 'number' || p.type === 'integer') out[key] = 0;
    else if (p.type === 'boolean') out[key] = false;
    else if (p.type === 'array') out[key] = [];
    else if (p.type === 'object') out[key] = {};
    else out[key] = 'example';
  }
  return out;
}

/**
 * Build the RoutesConfig (accepts + bazaar discovery extension) for the given
 * direct services. Exported separately so tests can inspect the route shape.
 */
export function buildSellerRoutes(
  directServices: SellerServiceEntry[],
  opts: SellerMiddlewareOptions,
): RoutesConfig {
  const routes: RoutesConfig = {};
  for (const svc of directServices) {
    const asset = opts.defaultAsset[svc.network];

    // Bazaar discovery extension: rides the 402 response → echoed into
    // paymentRequirements → forwarded by the facilitator on settle → the
    // discovery indexer auto-lists this service (settlement-driven ingestion).
    // A complete declaration raises metadataScore, which feeds ranking.
    // The SDK validates the example `input` against inputSchema, so when the
    // seller didn't provide one we synthesize a minimal schema-valid example.
    const discovery = declareDiscoveryExtension({
      bodyType: 'json',
      // `method` is stripped from the SDK's input TYPE (route-mount enrichment
      // is supposed to inject it), but the receipt-gate path serves routes
      // without that enrichment — and the discovery indexer's strict V2
      // validation rejects extensions lacking input.method. The runtime
      // builder accepts it fine, so declare it explicitly.
      ...( { method: 'POST' } as object),
      input: svc.discovery?.input ?? synthesizeExample(svc.inputSchema),
      inputSchema: svc.inputSchema ?? { type: 'object', additionalProperties: true },
      output: svc.discovery?.output?.example !== undefined
        ? { example: svc.discovery.output.example }
        : { example: { jobId: 'uuid', service: svc.name, output: '<string>' } },
    });

    (routes as Record<string, unknown>)[`POST /paid/compute/${svc.name}`] = {
      // One accept per declared scheme, in the seller's priority order. For
      // upto, x402Price is the ceiling (max authorization) — the actual settle
      // amount is decided by the settling code (≤ ceiling).
      accepts: svc.schemes.map((scheme) => ({
        scheme,
        network: svc.network as Network,
        payTo: opts.payTo,
        price: {
          amount: svc.x402Price,
          asset: asset.address,
          extra: { ...(asset.extra ?? {}) },
        },
        // Also the buyer's signature validity window (upto signs deadline =
        // now + maxTimeoutSeconds) — async/job services need hours, not 10min.
        maxTimeoutSeconds: svc.maxTimeoutSeconds ?? 600,
      })),
      description: svc.description,
      extensions: { ...discovery },
    };
  }
  return routes;
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
    if (directServices.some((s) => s.network === net && s.schemes.includes('upto'))) {
      schemes.push({ network: net as Network, server: new UptoEvmScheme() });
    }
  }

  const routes = buildSellerRoutes(directServices, opts);
  const middleware = paymentMiddlewareFromConfig(routes, facilitatorClients, schemes);
  return { middleware, routeKeys: Object.keys(routes) };
}

/**
 * Payment gate for receipt-enabled services: drives the x402 resource
 * server manually so the handler owns the order verify → run → settle → receipt
 * (the auto middleware settles only AFTER the response, too late to embed the
 * settle tx in a receipt). Same 402/verify/settle primitives, same facilitator.
 */
export interface ReceiptGate {
  http: InstanceType<typeof x402HTTPResourceServer>;
  /** Resolves once the facilitator's /supported has been fetched. */
  ready: Promise<void>;
  routeKeys: string[];
}

export function buildReceiptGate(
  receiptServices: SellerServiceEntry[],
  opts: SellerMiddlewareOptions,
): ReceiptGate {
  const networks = new Set(receiptServices.map((s) => s.network));
  const seenUrls = new Map<string, FacilitatorClient>();
  for (const net of networks) {
    const url = opts.facilitators[net];
    if (!url) throw new Error(`x402Seller: no facilitator URL configured for network "${net}"`);
    if (!opts.defaultAsset[net]) throw new Error(`x402Seller: no defaultAsset configured for network "${net}"`);
    if (!seenUrls.has(url)) seenUrls.set(url, new HTTPFacilitatorClient({ url }));
  }

  const server = new x402ResourceServer(Array.from(seenUrls.values()));
  for (const net of networks) {
    server.register(net as Network, new ExactEvmScheme());
    if (receiptServices.some((s) => s.network === net && s.schemes.includes('upto'))) {
      server.register(net as Network, new UptoEvmScheme());
    }
  }

  const routes = buildSellerRoutes(receiptServices, opts);
  const http = new x402HTTPResourceServer(server, routes);
  return { http, ready: http.initialize(), routeKeys: Object.keys(routes) };
}
