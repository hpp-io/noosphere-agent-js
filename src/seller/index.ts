/**
 * x402 Seller — service entry point.
 *
 * M0: config/catalog validation + read-only GET /paid/catalog.
 * M1: direct-settlement paid routes (POST /paid/compute/<svc>, exact scheme) —
 *     x402 payment → run container locally → return output.
 *
 * NOT yet: on-chain dispatch (M4), MCP transport (M3), discovery (M5).
 * Those are guarded/logged so the wiring is inert but discoverable.
 */

import type { Express, Request, Response } from 'express';
import { validateSellerConfig } from './catalog';
import { buildSellerMiddleware } from './routes';
import { inputGuard } from './validate-input';
import { makeDirectHandler } from './settlement/direct';
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

    const onchain = this.services.filter((s) => s.settlement === 'onchain');
    if (onchain.length > 0) {
      this.log.warn(
        `[x402-seller] ${onchain.length} on-chain service(s) not served yet (M4): ` +
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

    const { middleware, routeKeys } = buildSellerMiddleware(direct, {
      payTo: this.payTo!,
      facilitators,
      defaultAsset,
    });

    // Input validation runs BEFORE payment so invalid input is rejected (400)
    // without charging the buyer. Generic JSON-Schema per service's inputSchema.
    app.use(inputGuard(direct));

    // Payment middleware verifies X-PAYMENT for matched routes and settles
    // after a <400 response; unmatched routes (e.g. /api/*, /paid/catalog) pass through.
    app.use(middleware);

    for (const svc of direct) {
      const container = containers.get(svc.containerId);
      if (!container) {
        this.log.error(`[x402-seller] no container metadata for "${svc.containerId}" (service ${svc.name}) — skipped`);
        continue;
      }
      const asset = defaultAsset[svc.network]?.address;
      app.post(`/paid/compute/${svc.name}`, makeDirectHandler(svc, {
        runner,
        container,
        db,
        log: this.log,
        asset,
        timeoutMs: this.deps.timeoutMs,
      }));
    }

    this.log.info(`[x402-seller] mounted direct routes — ${routeKeys.join(', ')}`);
  }
}
