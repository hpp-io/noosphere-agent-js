/**
 * x402 Seller — service entry point.
 *
 * Wires everything the seller module offers onto the agent's Express app:
 *   - GET /paid/catalog (read-only service listing)
 *   - POST /paid/compute/<svc> paid routes (x402 → run container → settle),
 *     with optional execution receipts
 *   - MCP transport (/mcp) mirroring the paid routes as compute_<svc> tools
 *   - dashboard read API (/api/seller/*)
 *   - discovery announcement (bazaar on 402 + optional explicit registration)
 *
 * On-chain dispatch mode (settlement: "onchain") is roadmap — entries validate
 * but are not served yet.
 */

import type { Express, Request, Response } from 'express';
import { validateSellerConfig } from './catalog';
import { buildSellerMiddleware, buildReceiptGate } from './routes';
import { inputGuard } from './validate-input';
import { makeDirectHandler } from './settlement/direct';
import { makeReceiptHandler } from './settlement/receipt';
import { DiscoveryClient, registerSellerServices, type ListingSigner } from './discovery';
import { mountSellerApi } from './api';
import { mountSellerMcp } from './mcp';
import { startQuickTunnel, type DemoTunnel } from './tunnel';
import { SellerServiceEntry, X402SellerConfig } from './types';
import type { ContainerMeta, ContainerRunner, SellerJobsDb, SellerLogger } from './deps';

export interface SellerServiceDeps {
  /** Container metadata by id (from config.containers[]) — needed to run direct compute. */
  containers?: Map<string, ContainerMeta>;
  /** Explicit known container ids for validation; derived from `containers` when omitted. */
  knownContainerIds?: Set<string>;
  /** Runs containers for direct settlement (agent-core ContainerManager). */
  runner?: ContainerRunner;
  /** Job persistence. */
  db?: SellerJobsDb;
  /** Receiving address fallback (chain.wallet.paymentAddress) when payTo is unset. */
  defaultPayTo?: string;
  /** Container execution timeout (ms). */
  timeoutMs?: number;
  /** EOA signer for discovery listing registration (must equal payTo to register). */
  signer?: ListingSigner;
  /** Chain RPC url for dashboard balance reads (optional). */
  rpcUrl?: string;
  /** Local HTTP port (used by the demo tunnel). */
  port?: number;
  /** Injectable tunnel starter (tests). Defaults to Cloudflare Quick Tunnel. */
  startTunnel?: (localUrl: string) => Promise<DemoTunnel>;
  logger?: SellerLogger;
}

export { validateSellerConfig } from './catalog';
export * from './types';
export type { ContainerMeta, ContainerRunner, SellerJobsDb, SellerLogger } from './deps';

/** Build a container-metadata map from raw config.containers[] entries. */
export function buildContainerMetaMap(
  containers: Array<{ id: string; name?: string; image: string; port: string }>,
): Map<string, ContainerMeta> {
  const map = new Map<string, ContainerMeta>();
  for (const c of containers) {
    const [image, tag] = c.image.includes(':') ? c.image.split(':') : [c.image, 'latest'];
    map.set(c.id, {
      id: c.id,
      name: c.name ?? c.id.slice(0, 10),
      image,
      tag: tag ?? 'latest',
      port: c.port,
    });
  }
  return map;
}

export class SellerService {
  private services: SellerServiceEntry[] = [];
  private readonly log: SellerLogger;
  private initialized = false;
  private tunnel?: DemoTunnel;
  /** Resolves when the MCP transport is mounted (or skipped). Never rejects. */
  mcpReady: Promise<{ tools: string[] }> = Promise.resolve({ tools: [] });

  constructor(
    private readonly config: X402SellerConfig,
    private readonly deps: SellerServiceDeps = {},
  ) {
    this.log = deps.logger ?? {
      info: (m) => console.log(m),
      warn: (m) => console.warn(m),
      error: (m) => console.error(m),
    };
  }

  /** The address that receives payments. */
  get payTo(): string | undefined {
    return this.config.payTo ?? this.deps.defaultPayTo;
  }

  /** Validated, normalized service catalog (empty until initialize()). */
  getServices(): SellerServiceEntry[] {
    return this.services;
  }

  private knownContainerIds(): Set<string> | undefined {
    if (this.deps.knownContainerIds) return this.deps.knownContainerIds;
    if (this.deps.containers) return new Set(this.deps.containers.keys());
    return undefined;
  }

  /**
   * Validate config & catalog. Throws on invalid config so a misconfigured
   * seller fails fast at boot rather than at first paid request.
   */
  async initialize(): Promise<void> {
    const { services, errors } = validateSellerConfig(this.config, {
      knownContainerIds: this.knownContainerIds(),
    });

    if (errors.length > 0) {
      const detail = errors.map((e) => `  - ${e}`).join('\n');
      throw new Error(`x402Seller config invalid:\n${detail}`);
    }
    if (!this.payTo) {
      throw new Error('x402Seller: no payTo address (set x402Seller.payTo or chain.wallet.paymentAddress)');
    }

    this.services = services;
    this.initialized = true;

    const modes = services.reduce(
      (acc, s) => ((acc[s.settlement] = (acc[s.settlement] ?? 0) + 1), acc),
      {} as Record<string, number>,
    );
    this.log.info(
      `[x402-seller] initialized — ${services.length} service(s) ` +
        `(direct=${modes.direct ?? 0}, onchain=${modes.onchain ?? 0}), payTo=${this.payTo}`,
    );
  }

  /** Mount seller routes onto the shared Express app. */
  mount(app: Express): void {
    if (!this.initialized) {
      throw new Error('SellerService.mount() called before initialize()');
    }

    this.mountCatalog(app);
    this.mountDirectRoutes(app);
    this.mountDashboardApi(app);
    this.mountMcp(app);

    const onchain = this.services.filter((s) => s.settlement === 'onchain');
    if (onchain.length > 0) {
      this.log.warn(
        `[x402-seller] ${onchain.length} on-chain service(s) not served yet (roadmap): ` +
          onchain.map((s) => s.name).join(', '),
      );
    }
  }

  private mountCatalog(app: Express): void {
    app.get('/paid/catalog', (_req: Request, res: Response) => {
      res.json({
        payTo: this.payTo,
        discovery: this.config.discovery?.enabled ? this.config.discovery.url : null,
        services: this.services.map((s) => ({
          name: s.name,
          settlement: s.settlement,
          network: s.network,
          price: s.x402Price,
          schemes: s.schemes,
          description: s.description,
        })),
      });
    });
    this.log.info(`[x402-seller] mounted — GET /paid/catalog (${this.services.length} service(s))`);
  }

  private mountDirectRoutes(app: Express): void {
    const direct = this.services.filter((s) => s.settlement === 'direct');
    if (direct.length === 0) return;

    const { runner, db, containers } = this.deps;
    if (!runner || !db || !containers) {
      this.log.warn('[x402-seller] direct routes disabled — missing runner/db/containers deps');
      return;
    }

    const facilitators = this.config.facilitators ?? {};
    const defaultAsset = this.config.defaultAsset ?? {};
    const opts = { payTo: this.payTo!, facilitators, defaultAsset };

    // Input validation runs BEFORE payment so invalid input is rejected (400)
    // without charging the buyer. Generic JSON-Schema per service's inputSchema.
    app.use(inputGuard(direct));

    // receipt:true services use the manual gate (verify → run → settle →
    // receipt); the rest use the auto middleware (serve-then-settle).
    const withReceipt = direct.filter((s) => s.receipt === true);
    const plain = direct.filter((s) => s.receipt !== true);

    const mounted: string[] = [];

    if (plain.length > 0) {
      const { middleware, routeKeys } = buildSellerMiddleware(plain, opts);
      // Verifies X-PAYMENT for matched routes and settles after a <400
      // response; unmatched routes (e.g. /api/*, /paid/catalog) pass through.
      app.use(middleware);
      mounted.push(...routeKeys);
    }

    const gate = withReceipt.length > 0 ? buildReceiptGate(withReceipt, opts) : undefined;

    for (const svc of direct) {
      const container = containers.get(svc.containerId);
      if (!container) {
        this.log.error(`[x402-seller] no container metadata for "${svc.containerId}" (service ${svc.name}) — skipped`);
        continue;
      }
      const asset = defaultAsset[svc.network]?.address;
      const common = { runner, container, db, log: this.log, asset, timeoutMs: this.deps.timeoutMs };
      if (svc.receipt === true && gate) {
        app.post(`/paid/compute/${svc.name}`, makeReceiptHandler(svc, {
          ...common,
          gate: gate.http,
          gateReady: gate.ready.catch((err) => {
            this.log.error(`[x402-seller] receipt gate init failed: ${(err as Error).message}`);
          }) as Promise<void>,
        }));
        mounted.push(`POST /paid/compute/${svc.name} (receipt)`);
      } else {
        app.post(`/paid/compute/${svc.name}`, makeDirectHandler(svc, common));
      }
    }

    this.log.info(`[x402-seller] mounted direct routes — ${mounted.join(', ')}`);
  }

  /**
   * MCP transport — async (fetches facilitator /supported) so it mounts
   * in the background; a failure disables MCP but never the HTTP routes.
   */
  private mountMcp(app: Express): void {
    const { runner, db, containers } = this.deps;
    if (!runner || !db || !containers) return;
    this.mcpReady = mountSellerMcp({
      app,
      services: this.services,
      containers,
      runner,
      db,
      log: this.log,
      payTo: this.payTo!,
      facilitators: this.config.facilitators ?? {},
      defaultAsset: this.config.defaultAsset ?? {},
      timeoutMs: this.deps.timeoutMs,
      // Prefer an http(s) base for MCP resource URLs: the bazaar extractor
      // canonicalizes via `new URL(u).origin`, and WHATWG URL yields the
      // literal string "null" as origin for non-special schemes (mcp://) —
      // which corrupted discovery listings to "null/mcp/tools/<tool>".
      baseUrl: this.config.discovery?.publicBaseUrl,
    }).catch((err) => {
      this.log.error(`[x402-seller] mcp mount failed: ${(err as Error).message}`);
      return { tools: [] };
    });
  }

  /** Read-only dashboard API — requires the jobs db. */
  private mountDashboardApi(app: Express): void {
    const { db } = this.deps;
    if (!db) return;
    mountSellerApi(app, {
      db,
      getServices: () => this.services,
      payTo: this.payTo!,
      config: this.config,
      rpcUrl: this.deps.rpcUrl,
      agentAddress: this.deps.signer?.address,
      log: this.log,
    });
    this.log.info('[x402-seller] mounted dashboard API — GET /api/seller/{summary,wallets,services,jobs,earnings}');
  }

  /**
   * Post-listen announcement (call after the HTTP server is up):
   *   - demoTunnel: start a Quick Tunnel (TEST ONLY) → publicBaseUrl
   *   - discovery.register: explicitly register listings (ingest path B)
   * Best-effort — failures log and never take the agent down.
   */
  async announce(): Promise<void> {
    if (!this.initialized) return;
    const disc = this.config.discovery;

    // Resolve public base URL: demo tunnel overrides config.
    let publicBaseUrl = disc?.publicBaseUrl;
    if (this.config.demoTunnel) {
      try {
        const start = this.deps.startTunnel ?? startQuickTunnel;
        this.tunnel = await start(`http://localhost:${this.deps.port ?? 4000}`);
        publicBaseUrl = this.tunnel.url;
        this.log.warn(`[x402-seller] DEMO tunnel active (test only, ephemeral URL): ${publicBaseUrl}`);
      } catch (err) {
        this.log.error(`[x402-seller] demo tunnel failed: ${(err as Error).message}`);
      }
    }

    if (!disc?.enabled || !disc.register) return;

    const apiUrl = disc.apiUrl ?? disc.url;
    if (!apiUrl) {
      this.log.warn('[x402-seller] discovery.register=true but no apiUrl — skipping registration');
      return;
    }
    if (!publicBaseUrl) {
      this.log.warn('[x402-seller] discovery.register=true but no publicBaseUrl (set discovery.publicBaseUrl, or demoTunnel for tests) — skipping; passive settle-indexing (bazaar) still applies');
      return;
    }

    // Registration signature must recover to payTo (discovery treats the signer
    // as the listing owner). If payTo isn't our signer EOA we can't register —
    // fall back to passive indexing. (P1-1 policy warning.)
    const signer = this.deps.signer;
    if (!signer || signer.address.toLowerCase() !== this.payTo!.toLowerCase()) {
      this.log.warn(
        `[x402-seller] discovery.register skipped: payTo (${this.payTo}) is not the agent signer EOA` +
          `${signer ? ` (${signer.address})` : ''}. Set x402Seller.payTo to a wallet you can sign with, ` +
          'or rely on passive settle-indexing (first paid call lists you automatically).',
      );
      return;
    }

    const assetByNetwork: Record<string, string> = {};
    for (const [net, a] of Object.entries(this.config.defaultAsset ?? {})) assetByNetwork[net] = a.address;

    await registerSellerServices({
      client: new DiscoveryClient({ apiUrl }),
      services: this.services.filter((s) => s.settlement === 'direct'),
      publicBaseUrl,
      assetByNetwork,
      signer,
      log: this.log,
    });
  }

  /** Stop background resources (demo tunnel). */
  shutdown(): void {
    this.tunnel?.stop();
    this.tunnel = undefined;
  }
}
