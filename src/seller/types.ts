/**
 * x402 Seller — configuration & catalog types.
 *
 * The seller module lets a Noosphere agent sell its compute over HTTP/MCP via
 * x402 payments, in addition to the existing on-chain subscription rail.
 *
 * Two settlement modes per service (see design doc 02 §2):
 *   - "direct":  x402 payment → run the container locally → return over HTTP.
 *                No verifier / subscription. Low friction, seller keeps ~100%.
 *   - "onchain": x402 payment → dispatchPaidCompute on-chain → verifier delivery.
 *                Verifiable, margin = x402Price - feeAmount. Needs operator setup.
 *
 * M0 only defines/validates config. Payment handling arrives in M1+.
 */

export type Settlement = 'direct' | 'onchain';

export interface SellerServiceEntry {
  /** Unique service name; becomes the /paid/compute/<name> route + compute_<name> MCP tool. */
  name: string;
  /** Container to run — references an id in config.containers[]. */
  containerId: string;
  /** Settlement mode. Default "direct". */
  settlement: Settlement;
  /** x402 network, e.g. "eip155:181228" (HPP Sepolia). */
  network: string;
  /** Price the buyer pays, in atomic units of the asset (integer string), e.g. "10000". */
  x402Price: string;
  /** Accepted x402 schemes in seller priority order. Default ["exact"]. */
  schemes: string[];
  /** Optional JSON-schema subset validated before payment. */
  inputSchema?: Record<string, unknown>;
  /** Human-readable description (shown in catalog / discovery). */
  description?: string;

  // --- direct-only ---
  /** Emit a verifiable execution receipt with the result. Default false. */
  receipt?: boolean;

  // --- onchain-only ---
  /** USDC.e the operator pays Noosphere for compute (atomic string). margin = x402Price - feeAmount. */
  feeAmount?: string;
  /** Verifier contract address (0x0 = NO_VERIFIER). */
  verifier?: string;
  /** Route id, e.g. "Coordinator_v1.0.0". */
  routeId?: string;
  /** Env var name holding the on-chain subscription id (filled by setup:seller). */
  subscriptionEnv?: string;
}

/** Raw (pre-validation) service entry as it appears in config.json. All fields optional. */
export type RawSellerServiceEntry = Partial<SellerServiceEntry> & { name?: string };

export interface X402SellerAssetConfig {
  address: string;
  /** EIP-712 domain hints for exact/EIP-3009 (e.g. { name: "Bridged USDC", version: "2" }). */
  extra?: Record<string, string>;
}

export interface X402SellerDiscoveryConfig {
  enabled?: boolean;
  url?: string;
}

export interface X402SellerConfig {
  /** Master switch. When false/absent the seller module is inert (no routes, no side effects). */
  enabled?: boolean;
  /** Override the receiving address; defaults to chain.wallet.paymentAddress. */
  payTo?: string;
  /** Facilitator base URL per network, e.g. { "eip155:181228": "https://facilitator-sepolia.hpp.io" }. */
  facilitators?: Record<string, string>;
  /** Default payment asset per network (USDC.e). */
  defaultAsset?: Record<string, X402SellerAssetConfig>;
  /** Optional discovery-service registration. */
  discovery?: X402SellerDiscoveryConfig;
  /** Services offered for sale. */
  services?: RawSellerServiceEntry[];
}
