/**
 * x402 Seller — catalog validation.
 *
 * Pure, dependency-free validation of the `x402Seller` config block so misconfig
 * is caught at boot (or in unit tests) rather than at first paid request.
 */

import {
  RawSellerServiceEntry,
  SellerServiceEntry,
  Settlement,
  X402SellerConfig,
} from './types';

const ATOMIC_RE = /^\d+$/; // non-negative integer, atomic token units
const VALID_SETTLEMENTS: Settlement[] = ['direct', 'onchain'];

export interface CatalogValidationResult {
  /** Normalized, valid service entries (defaults applied). */
  services: SellerServiceEntry[];
  /** Human-readable validation errors; empty ⇒ config is usable. */
  errors: string[];
}

export interface ValidateOptions {
  /** Known container ids (from config.containers[]). When provided & non-empty, containerId must be a member. */
  knownContainerIds?: Set<string>;
}

/**
 * Validate & normalize the seller config. Never throws — collects errors so the
 * caller decides whether to fail boot or warn.
 */
export function validateSellerConfig(
  cfg: X402SellerConfig | undefined,
  opts: ValidateOptions = {},
): CatalogValidationResult {
  const errors: string[] = [];
  const services: SellerServiceEntry[] = [];

  if (!cfg || !cfg.enabled) {
    return { services, errors }; // inert — nothing to validate
  }

  const rawServices = cfg.services ?? [];
  if (!Array.isArray(rawServices)) {
    return { services, errors: ['x402Seller.services must be an array'] };
  }

  const seenNames = new Set<string>();
  const checkContainers = !!opts.knownContainerIds && opts.knownContainerIds.size > 0;

  rawServices.forEach((raw, i) => {
    const where = `x402Seller.services[${i}]${raw?.name ? ` (${raw.name})` : ''}`;
    const svc = validateEntry(raw, where, errors, {
      seenNames,
      knownContainerIds: checkContainers ? opts.knownContainerIds : undefined,
    });
    if (svc) services.push(svc);
  });

  return { services, errors };
}

function validateEntry(
  raw: RawSellerServiceEntry,
  where: string,
  errors: string[],
  ctx: { seenNames: Set<string>; knownContainerIds?: Set<string> },
): SellerServiceEntry | null {
  const before = errors.length;

  // name
  const name = (raw.name ?? '').trim();
  if (!name) {
    errors.push(`${where}: "name" is required`);
  } else if (ctx.seenNames.has(name)) {
    errors.push(`${where}: duplicate service name "${name}"`);
  } else {
    ctx.seenNames.add(name);
  }

  // settlement
  const settlement: Settlement = (raw.settlement ?? 'direct') as Settlement;
  if (!VALID_SETTLEMENTS.includes(settlement)) {
    errors.push(`${where}: "settlement" must be one of ${VALID_SETTLEMENTS.join(' | ')}`);
  }

  // containerId
  const containerId = (raw.containerId ?? '').trim();
  if (!containerId) {
    errors.push(`${where}: "containerId" is required`);
  } else if (ctx.knownContainerIds && !ctx.knownContainerIds.has(containerId)) {
    errors.push(`${where}: containerId "${containerId}" is not declared in config.containers[]`);
  }

  // network
  const network = (raw.network ?? '').trim();
  if (!network) errors.push(`${where}: "network" is required`);

  // x402Price
  const x402Price = (raw.x402Price ?? '').trim();
  if (!x402Price) {
    errors.push(`${where}: "x402Price" is required`);
  } else if (!ATOMIC_RE.test(x402Price)) {
    errors.push(`${where}: "x402Price" must be an atomic integer string (got "${x402Price}")`);
  }

  // schemes
  let schemes = raw.schemes;
  if (schemes === undefined) {
    schemes = ['exact'];
  } else if (!Array.isArray(schemes) || schemes.length === 0 || !schemes.every(s => typeof s === 'string' && s.length > 0)) {
    errors.push(`${where}: "schemes" must be a non-empty array of strings`);
    schemes = ['exact'];
  }

  // onchain-only requirements
  if (settlement === 'onchain') {
    const feeAmount = (raw.feeAmount ?? '').trim();
    if (!feeAmount) {
      errors.push(`${where}: onchain settlement requires "feeAmount"`);
    } else if (!ATOMIC_RE.test(feeAmount)) {
      errors.push(`${where}: "feeAmount" must be an atomic integer string (got "${feeAmount}")`);
    } else if (ATOMIC_RE.test(x402Price) && BigInt(feeAmount) > BigInt(x402Price)) {
      errors.push(`${where}: "feeAmount" (${feeAmount}) must not exceed "x402Price" (${x402Price})`);
    }
  }

  // job — async job mode (optional); perMinuteAtomic must be an atomic int
  if (raw.job !== undefined) {
    const rate = (raw.job as { perMinuteAtomic?: string })?.perMinuteAtomic;
    if (typeof rate !== 'string' || !ATOMIC_RE.test(rate)) {
      errors.push(`${where}: "job.perMinuteAtomic" must be an atomic integer string`);
    }
  }

  // maxTimeoutSeconds — optional positive integer (seconds)
  if (raw.maxTimeoutSeconds !== undefined
      && (!Number.isInteger(raw.maxTimeoutSeconds) || raw.maxTimeoutSeconds <= 0)) {
    errors.push(`${where}: "maxTimeoutSeconds" must be a positive integer (seconds)`);
  }

  if (errors.length !== before) return null; // this entry had errors

  return {
    name,
    containerId,
    settlement,
    network,
    x402Price,
    schemes: schemes as string[],
    ...(raw.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: raw.maxTimeoutSeconds } : {}),
    ...(raw.job ? { job: raw.job } : {}),
    ...(raw.inputSchema ? { inputSchema: raw.inputSchema } : {}),
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.discovery ? { discovery: raw.discovery } : {}),
    ...(raw.receipt !== undefined ? { receipt: !!raw.receipt } : {}),
    ...(raw.feeAmount ? { feeAmount: raw.feeAmount.trim() } : {}),
    ...(raw.verifier ? { verifier: raw.verifier } : {}),
    ...(raw.routeId ? { routeId: raw.routeId } : {}),
    ...(raw.subscriptionEnv ? { subscriptionEnv: raw.subscriptionEnv } : {}),
  };
}
