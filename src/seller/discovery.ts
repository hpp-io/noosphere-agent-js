/**
 * x402 Seller — explicit discovery registration.
 *
 * Flow per listing:
 *   POST {apiUrl}/listings/challenge {payTo, action:'register'}   → {nonce, message|typedData}
 *   sign the challenge with the payTo EOA (EIP-712 typedData, or legacy personal_sign)
 *   POST {apiUrl}/listings/register  {...listing, nonce, signature} → 201 (state=pending)
 *
 * The signature must recover to payTo — discovery treats the recovered address
 * as authoritative. Registration is best-effort: failures are logged, never fatal.
 * (The passive path A — bazaar extension on settle — indexes us regardless.)
 *
 * Each direct service can produce up to two listings: an `http` route
 * (`/paid/compute/<name>`) and, when its MCP tool is mounted, an `mcp` listing
 * (tool `compute_<name>` at `<publicBaseUrl>/mcp`). Discovery consumes the
 * challenge nonce *before* its per-payTo register rate limit, so a 429 burns the
 * nonce — retries therefore re-issue the challenge from scratch.
 */

import type { SellerServiceEntry } from './types';
import type { SellerLogger } from './deps';

/** Minimal signer surface (satisfied by ethers Wallet). */
export interface ListingSigner {
  address: string;
  signMessage(message: string): Promise<string>;
  /** EIP-712 signing — required by current discovery challenges. */
  signTypedData?(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string>;
}

export interface DiscoveryClientOptions {
  apiUrl: string;
  fetchImpl?: typeof fetch;
  /**
   * Retry policy for the discovery register rate limit (HTTP 429). Defaults to
   * 6 retries spaced 11s apart — enough to ride out the default 6-per-minute
   * sliding window. Set attempts to 0 to disable (used by tests).
   */
  rateLimitRetry?: { attempts?: number; delayMs?: number };
  /** Injectable sleep (tests). */
  sleepImpl?: (ms: number) => Promise<void>;
}

export type ListingTransport = 'http' | 'mcp';

export interface RegisterArgs {
  service: SellerServiceEntry;
  publicBaseUrl: string;
  asset: string;
  signer: ListingSigner;
  /** Also register the MCP transport variant (tool `compute_<name>`). */
  mcp?: boolean;
}

export interface RegisterResult {
  service: string;
  transport: ListingTransport;
  ok: boolean;
  status?: number;
  state?: string;
  error?: string;
}

/** One listing to register (endpoint identity + payment terms). */
interface ListingSpec {
  service: string;
  transport: ListingTransport;
  resourceUrl: string;
  /** http only */
  httpMethod?: string;
  bodyType?: string;
  /** mcp only */
  toolName?: string;
  mcpTransport?: string;
  network: string;
  asset: string;
  priceAtomic: string;
  scheme: string;
  description?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

const DEFAULT_RETRY_ATTEMPTS = 6;
const DEFAULT_RETRY_DELAY_MS = 11_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DiscoveryClient {
  private readonly apiUrl: string;
  private readonly fetch: typeof fetch;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: DiscoveryClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, '');
    this.fetch = opts.fetchImpl ?? fetch;
    this.retryAttempts = opts.rateLimitRetry?.attempts ?? DEFAULT_RETRY_ATTEMPTS;
    this.retryDelayMs = opts.rateLimitRetry?.delayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.sleep = opts.sleepImpl ?? defaultSleep;
  }

  private async post(path: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await this.fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  /**
   * Register the listing(s) for one service: always the HTTP route, plus the MCP
   * variant when `args.mcp` is set. Returns one result per listing, never throws.
   */
  async register(args: RegisterArgs): Promise<RegisterResult[]> {
    const { service: svc } = args;
    const base = args.publicBaseUrl.replace(/\/$/, '');
    const common = {
      service: svc.name,
      network: svc.network,
      asset: args.asset,
      priceAtomic: svc.x402Price,
      scheme: svc.schemes[0] ?? 'exact',
      description: svc.description,
      // Human title + discovery ranking metadata (falls back to the service name).
      serviceName: svc.discovery?.serviceName ?? svc.name,
      tags: svc.discovery?.tags,
      iconUrl: svc.discovery?.iconUrl,
    };

    const specs: ListingSpec[] = [
      {
        ...common,
        transport: 'http',
        resourceUrl: `${base}/paid/compute/${svc.name}`,
        httpMethod: 'POST',
        bodyType: 'json',
      },
    ];
    if (args.mcp) {
      specs.push({
        ...common,
        transport: 'mcp',
        resourceUrl: `${base}/mcp`,
        toolName: `compute_${svc.name}`,
        mcpTransport: 'streamable-http',
      });
    }

    const results: RegisterResult[] = [];
    for (const spec of specs) {
      results.push(await this.registerListing(spec, args.signer));
    }
    return results;
  }

  /** Challenge → sign → register a single listing, retrying on the 429 rate limit. */
  private async registerListing(spec: ListingSpec, signer: ListingSigner): Promise<RegisterResult> {
    const fail = (r: Partial<RegisterResult>): RegisterResult => ({
      service: spec.service, transport: spec.transport, ok: false, ...r,
    });

    for (let attempt = 0; ; attempt++) {
      try {
        // 1) challenge (bound to the payTo address = signer address)
        const ch = await this.post('/listings/challenge', { payTo: signer.address, action: 'register' });
        if (ch.status >= 400 || !ch.json?.nonce || (!ch.json?.message && !ch.json?.typedData)) {
          // A rate-limited challenge is worth retrying; other failures are terminal.
          if (ch.status === 429 && attempt < this.retryAttempts) { await this.sleep(this.retryDelayMs); continue; }
          return fail({ status: ch.status, error: `challenge failed: ${JSON.stringify(ch.json).slice(0, 200)}` });
        }

        // 2) sign the server-issued challenge with the payTo EOA. Current
        //    discovery issues EIP-712 typedData; older deployments a plain message.
        let signature: string;
        const td = ch.json.typedData;
        if (td) {
          if (!signer.signTypedData) {
            return fail({ error: 'discovery requires EIP-712 signing but signer has no signTypedData' });
          }
          const { EIP712Domain: _d, ...types } = (td.types ?? {}) as Record<string, Array<{ name: string; type: string }>>;
          signature = await signer.signTypedData(td.domain, types, td.message);
        } else {
          signature = await signer.signMessage(ch.json.message);
        }

        // 3) register. The nonce is consumed server-side *before* the rate-limit
        //    check, so a 429 here burns it — the loop re-challenges on retry.
        const reg = await this.post('/listings/register', {
          type: spec.transport,
          resourceUrl: spec.resourceUrl,
          httpMethod: spec.httpMethod,
          toolName: spec.toolName,
          bodyType: spec.bodyType,
          transport: spec.mcpTransport,
          network: spec.network,
          asset: spec.asset,
          priceAtomic: spec.priceAtomic,
          scheme: spec.scheme,
          description: spec.description,
          serviceName: spec.serviceName,
          tags: spec.tags,
          iconUrl: spec.iconUrl,
          nonce: ch.json.nonce,
          signature,
        });
        if (reg.status === 429 && attempt < this.retryAttempts) { await this.sleep(this.retryDelayMs); continue; }
        if (reg.status >= 400) {
          return fail({ status: reg.status, error: JSON.stringify(reg.json).slice(0, 200) });
        }
        return {
          service: spec.service, transport: spec.transport, ok: true,
          status: reg.status, state: reg.json?.listingState ?? reg.json?.state,
        };
      } catch (err) {
        return fail({ error: (err as Error).message });
      }
    }
  }
}

/** Register all direct services (HTTP + mounted-MCP variants); logs a one-line summary. Best-effort. */
export async function registerSellerServices(args: {
  client: DiscoveryClient;
  services: SellerServiceEntry[];
  publicBaseUrl: string;
  assetByNetwork: Record<string, string>;
  signer: ListingSigner;
  log: SellerLogger;
  /** Mounted MCP tool names (`compute_<name>`); a service is MCP-registered only if present. */
  mcpTools?: Set<string>;
}): Promise<RegisterResult[]> {
  const results: RegisterResult[] = [];
  for (const svc of args.services) {
    const asset = args.assetByNetwork[svc.network];
    if (!asset) {
      results.push({ service: svc.name, transport: 'http', ok: false, error: `no asset for network ${svc.network}` });
      continue;
    }
    const mcp = args.mcpTools?.has(`compute_${svc.name}`) ?? false;
    results.push(...await args.client.register({
      service: svc,
      publicBaseUrl: args.publicBaseUrl,
      asset,
      signer: args.signer,
      mcp,
    }));
  }
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  args.log.info(`[x402-seller] discovery register: ${ok}/${results.length} ok` +
    (failed.length ? ` — failed: ${failed.map((f) => `${f.service}/${f.transport}(${f.error ?? f.status})`).join(', ')}` : ''));
  return results;
}
