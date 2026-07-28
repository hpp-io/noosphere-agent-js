/**
 * x402 Seller — explicit discovery registration.
 *
 * Flow per service:
 *   POST {apiUrl}/listings/challenge {payTo, action:'register'}   → {nonce, message}
 *   sign message with the payTo EOA (EIP-191 personal_sign)
 *   POST {apiUrl}/listings/register  {...listing, nonce, signature} → 201 (state=pending)
 *
 * The signature must recover to payTo — discovery treats the recovered address
 * as authoritative. Registration is best-effort: failures are logged, never fatal.
 * (The passive path A — bazaar extension on settle — indexes us regardless.)
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
}

export interface RegisterArgs {
  service: SellerServiceEntry;
  publicBaseUrl: string;
  asset: string;
  signer: ListingSigner;
}

export interface RegisterResult {
  service: string;
  ok: boolean;
  status?: number;
  state?: string;
  error?: string;
}

export class DiscoveryClient {
  private readonly apiUrl: string;
  private readonly fetch: typeof fetch;

  constructor(opts: DiscoveryClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, '');
    this.fetch = opts.fetchImpl ?? fetch;
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

  /** Register one service listing. Returns a result, never throws. */
  async register(args: RegisterArgs): Promise<RegisterResult> {
    const { service: svc, signer } = args;
    try {
      // 1) challenge (bound to the payTo address = signer address)
      const ch = await this.post('/listings/challenge', {
        payTo: signer.address,
        action: 'register',
      });
      if (ch.status >= 400 || !ch.json?.nonce || (!ch.json?.message && !ch.json?.typedData)) {
        return { service: svc.name, ok: false, status: ch.status, error: `challenge failed: ${JSON.stringify(ch.json).slice(0, 200)}` };
      }

      // 2) sign the server-issued challenge with the payTo EOA.
      //    Current discovery issues an EIP-712 typedData challenge; older
      //    deployments issued a plain personal_sign message.
      let signature: string;
      const td = ch.json.typedData;
      if (td) {
        if (!signer.signTypedData) {
          return { service: svc.name, ok: false, error: 'discovery requires EIP-712 signing but signer has no signTypedData' };
        }
        const { EIP712Domain: _d, ...types } = (td.types ?? {}) as Record<string, Array<{ name: string; type: string }>>;
        signature = await signer.signTypedData(td.domain, types, td.message);
      } else {
        signature = await signer.signMessage(ch.json.message);
      }

      // 3) register
      const resourceUrl = `${args.publicBaseUrl.replace(/\/$/, '')}/paid/compute/${svc.name}`;
      const reg = await this.post('/listings/register', {
        type: 'http',
        resourceUrl,
        httpMethod: 'POST',
        bodyType: 'json',
        network: svc.network,
        asset: args.asset,
        priceAtomic: svc.x402Price,
        scheme: svc.schemes[0] ?? 'exact',
        description: svc.description,
        nonce: ch.json.nonce,
        signature,
      });
      if (reg.status >= 400) {
        return { service: svc.name, ok: false, status: reg.status, error: JSON.stringify(reg.json).slice(0, 200) };
      }
      return { service: svc.name, ok: true, status: reg.status, state: reg.json?.listingState ?? reg.json?.state };
    } catch (err) {
      return { service: svc.name, ok: false, error: (err as Error).message };
    }
  }
}

/** Register all direct services; logs a one-line summary. Best-effort. */
export async function registerSellerServices(args: {
  client: DiscoveryClient;
  services: SellerServiceEntry[];
  publicBaseUrl: string;
  assetByNetwork: Record<string, string>;
  signer: ListingSigner;
  log: SellerLogger;
}): Promise<RegisterResult[]> {
  const results: RegisterResult[] = [];
  for (const svc of args.services) {
    const asset = args.assetByNetwork[svc.network];
    if (!asset) {
      results.push({ service: svc.name, ok: false, error: `no asset for network ${svc.network}` });
      continue;
    }
    results.push(await args.client.register({
      service: svc,
      publicBaseUrl: args.publicBaseUrl,
      asset,
      signer: args.signer,
    }));
  }
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  args.log.info(`[x402-seller] discovery register: ${ok}/${results.length} ok` +
    (failed.length ? ` — failed: ${failed.map((f) => `${f.service}(${f.error ?? f.status})`).join(', ')}` : ''));
  return results;
}
