import { EventEmitter } from 'events';
import { ethers, Contract, JsonRpcProvider, WebSocketProvider, Wallet } from 'ethers';
import { logger } from '../../lib/logger';
import { VRFConfig, VRFStatus } from '../types';
import * as fs from 'fs';
import * as path from 'path';

// Load NoosphereVRF ABI
const VRF_ABI_PATH = path.join(__dirname, '../../abis/NoosphereVRF.json');

/**
 * EpochManager — manages NoosphereVRF epoch lifecycle.
 *
 * Responsibilities:
 *   1. On startup: ensure current epoch is registered
 *   2. Listen for EpochRunningLow events → auto-register next epoch
 *   3. Communicate with VRNG container to get Merkle roots
 *   4. Send registerEpoch() transactions to NoosphereVRF
 */
export class EpochManager extends EventEmitter {
  private vrfContract?: Contract;
  private vrfContractReadOnly?: Contract;
  private provider?: JsonRpcProvider | WebSocketProvider;
  private signer?: Wallet;
  private vrfAbi: any[];

  private currentEpoch: number = 0;
  private epochRemaining: number = 0;
  private epochSize: number = 1000;
  private pendingRegistration: Set<number> = new Set();
  private lastRegistrationTx?: string;
  private lastRegistrationEpoch?: number;
  private pollingTimer?: NodeJS.Timeout;
  private running: boolean = false;
  private isVrfOwner: boolean = false;
  private vrfOwner?: string;

  constructor(
    private config: VRFConfig,
    private rpcUrl: string,
    private wsRpcUrl?: string,
  ) {
    super();

    // Load ABI
    if (!fs.existsSync(VRF_ABI_PATH)) {
      throw new Error(`NoosphereVRF ABI not found at ${VRF_ABI_PATH}`);
    }
    this.vrfAbi = JSON.parse(fs.readFileSync(VRF_ABI_PATH, 'utf-8'));
  }

  /**
   * Initialize with a signer (from agent's keystore)
   */
  async start(privateKey: string): Promise<void> {
    logger.info('[EpochManager] Starting...');

    // Create provider (prefer WebSocket for event listening)
    if (this.wsRpcUrl) {
      try {
        this.provider = new WebSocketProvider(this.wsRpcUrl);
        logger.info('[EpochManager] Using WebSocket provider for events');
      } catch {
        logger.warn('[EpochManager] WebSocket failed, falling back to HTTP');
        this.provider = new JsonRpcProvider(this.rpcUrl);
      }
    } else {
      this.provider = new JsonRpcProvider(this.rpcUrl);
    }

    // Create signer
    this.signer = new Wallet(privateKey, this.provider);
    const signerAddress = await this.signer.getAddress();

    // Create contract instances
    this.vrfContractReadOnly = new Contract(this.config.vrfAddress, this.vrfAbi, this.provider);
    this.vrfContract = new Contract(this.config.vrfAddress, this.vrfAbi, this.signer);

    // Check ownership
    try {
      this.vrfOwner = await this.vrfContractReadOnly.owner();
      this.isVrfOwner = this.vrfOwner?.toLowerCase() === signerAddress.toLowerCase();

      if (!this.isVrfOwner) {
        logger.warn(`[EpochManager] Agent EOA (${signerAddress}) is NOT the VRF owner (${this.vrfOwner})`);
        logger.warn('[EpochManager] Auto-registration will fail. Only monitoring mode.');
      } else {
        logger.info(`[EpochManager] Agent EOA is VRF owner`);
      }
    } catch (err) {
      logger.warn(`[EpochManager] Could not check VRF owner: ${(err as Error).message}`);
    }

    // Read current epoch state
    await this.refreshEpochState();

    // Check VRNG container health
    await this.checkVrngHealth();

    // Ensure current epoch is registered
    if (this.isVrfOwner) {
      await this.ensureEpochRegistered(this.currentEpoch);
    }

    // Set up event listener for EpochRunningLow
    this.setupEventListener();

    // Fallback: periodic polling (in case events are missed)
    const pollingMs = this.config.pollingIntervalMs ?? 60000;
    this.pollingTimer = setInterval(async () => {
      try {
        await this.refreshEpochState();
        // If epoch is running low, trigger registration
        const threshold = this.config.epochLowThreshold ?? 100;
        if (this.epochRemaining > 0 && this.epochRemaining < threshold) {
          await this.handleEpochLow(this.currentEpoch, this.epochRemaining);
        }
      } catch (err) {
        logger.error(`[EpochManager] Polling error: ${(err as Error).message}`);
      }
    }, pollingMs);

    this.running = true;
    logger.info(`[EpochManager] Started. Epoch ${this.currentEpoch}, remaining ${this.epochRemaining}`);
    this.emit('started');
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }

    if (this.vrfContractReadOnly) {
      this.vrfContractReadOnly.removeAllListeners();
    }

    // Clean up WebSocket provider
    if (this.provider instanceof WebSocketProvider) {
      await this.provider.destroy();
    }

    logger.info('[EpochManager] Stopped');
    this.emit('stopped');
  }

  // ═══════════════════════════════════════════════════════════
  // Core Logic
  // ═══════════════════════════════════════════════════════════

  /**
   * Ensure a specific epoch is registered. If not, fetch root from VRNG and register.
   */
  async ensureEpochRegistered(epoch: number): Promise<void> {
    if (!this.vrfContractReadOnly || !this.vrfContract) return;

    try {
      const root = await this.vrfContractReadOnly.getEpochRoot(epoch);
      if (root !== ethers.ZeroHash) {
        logger.info(`[EpochManager] Epoch ${epoch} already registered (root: ${root.slice(0, 18)}...)`);
        return;
      }

      logger.info(`[EpochManager] Epoch ${epoch} not registered. Fetching root from VRNG...`);
      await this.registerEpoch(epoch);
    } catch (err) {
      logger.error(`[EpochManager] ensureEpochRegistered(${epoch}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Register a new epoch: fetch Merkle root from VRNG container, then send tx.
   */
  async registerEpoch(epoch: number): Promise<string | undefined> {
    if (this.pendingRegistration.has(epoch)) {
      logger.info(`[EpochManager] Epoch ${epoch} registration already pending, skipping`);
      return undefined;
    }

    if (!this.isVrfOwner) {
      logger.warn(`[EpochManager] Cannot register epoch ${epoch}: not VRF owner`);
      return undefined;
    }

    this.pendingRegistration.add(epoch);
    const maxRetries = this.config.retryAttempts ?? 3;
    const retryDelay = this.config.retryDelayMs ?? 10000;

    try {
      // Step 1: Fetch Merkle root from VRNG container
      const merkleRoot = await this.retryAsync(
        () => this.fetchMerkleRoot(epoch),
        maxRetries,
        retryDelay,
        `fetchMerkleRoot(${epoch})`,
      );

      if (!merkleRoot) {
        logger.error(`[EpochManager] Failed to fetch Merkle root for epoch ${epoch}`);
        return undefined;
      }

      // Step 2: Send registerEpoch tx
      const txHash = await this.retryAsync(
        () => this.sendRegisterEpochTx(epoch, merkleRoot),
        maxRetries,
        retryDelay,
        `registerEpoch(${epoch})`,
      );

      if (txHash) {
        this.lastRegistrationTx = txHash;
        this.lastRegistrationEpoch = epoch;
        logger.info(`[EpochManager] Epoch ${epoch} registered! tx: ${txHash}`);
        this.emit('epochRegistered', { epoch, merkleRoot, txHash });
      }

      return txHash;
    } finally {
      this.pendingRegistration.delete(epoch);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // VRNG Container Communication
  // ═══════════════════════════════════════════════════════════

  /**
   * Fetch Merkle root from VRNG container via init_epoch action.
   */
  private async fetchMerkleRoot(epoch: number): Promise<string> {
    const url = `${this.config.vrngContainerUrl}/computation`;
    const body = {
      input: {
        action: 'init_epoch',
        epoch,
        epoch_size: this.epochSize,
      },
    };

    logger.info(`[EpochManager] Requesting Merkle root from VRNG: epoch=${epoch}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`VRNG init_epoch failed (${response.status}): ${errorText}`);
    }

    const rootHex = (await response.text()).trim();

    // Validate format: 0x + 64 hex chars
    if (!/^0x[0-9a-fA-F]{64}$/.test(rootHex)) {
      throw new Error(`Invalid Merkle root format from VRNG: ${rootHex.slice(0, 20)}...`);
    }

    logger.info(`[EpochManager] Got Merkle root for epoch ${epoch}: ${rootHex.slice(0, 18)}...`);
    return rootHex;
  }

  /**
   * Check VRNG container health.
   */
  private async checkVrngHealth(): Promise<void> {
    try {
      const response = await fetch(`${this.config.vrngContainerUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        logger.info('[EpochManager] VRNG container health: OK');
      } else {
        logger.warn(`[EpochManager] VRNG container health check failed: ${response.status}`);
      }
    } catch (err) {
      logger.warn(`[EpochManager] VRNG container unreachable: ${(err as Error).message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // On-Chain Interaction
  // ═══════════════════════════════════════════════════════════

  /**
   * Send registerEpoch transaction to NoosphereVRF.
   */
  private async sendRegisterEpochTx(epoch: number, merkleRoot: string): Promise<string> {
    if (!this.vrfContract) throw new Error('VRF contract not initialized');

    logger.info(`[EpochManager] Sending registerEpoch(${epoch}, ${merkleRoot.slice(0, 18)}...)`);

    const tx = await this.vrfContract.registerEpoch(epoch, merkleRoot);
    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error(`registerEpoch tx failed: ${receipt?.hash}`);
    }

    return receipt.hash;
  }

  /**
   * Refresh current epoch state from on-chain.
   */
  private async refreshEpochState(): Promise<void> {
    if (!this.vrfContractReadOnly) return;

    try {
      const [currentEpoch, epochRemaining, epochSize] = await Promise.all([
        this.vrfContractReadOnly.getCurrentEpoch(),
        this.vrfContractReadOnly.getEpochRemaining(),
        this.vrfContractReadOnly.EPOCH_SIZE(),
      ]);

      this.currentEpoch = Number(currentEpoch);
      this.epochRemaining = Number(epochRemaining);
      this.epochSize = Number(epochSize);
    } catch (err) {
      logger.error(`[EpochManager] refreshEpochState failed: ${(err as Error).message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Event Handling
  // ═══════════════════════════════════════════════════════════

  private setupEventListener(): void {
    if (!this.vrfContractReadOnly) return;

    try {
      this.vrfContractReadOnly.on('EpochRunningLow', (epoch: bigint, remaining: bigint) => {
        const epochNum = Number(epoch);
        const remainingNum = Number(remaining);
        logger.info(`[EpochManager] EpochRunningLow event: epoch=${epochNum}, remaining=${remainingNum}`);
        this.emit('epochRunningLow', { epoch: epochNum, remaining: remainingNum });
        this.handleEpochLow(epochNum, remainingNum);
      });

      logger.info('[EpochManager] Listening for EpochRunningLow events');
    } catch (err) {
      logger.warn(`[EpochManager] Failed to set up event listener: ${(err as Error).message}`);
      logger.info('[EpochManager] Falling back to polling only');
    }
  }

  private async handleEpochLow(epoch: number, remaining: number): Promise<void> {
    if (!this.isVrfOwner || !(this.config.autoRegisterEpoch ?? true)) {
      return;
    }

    const nextEpoch = epoch + 1;

    // Check if next epoch already registered
    try {
      if (!this.vrfContractReadOnly) return;
      const root = await this.vrfContractReadOnly.getEpochRoot(nextEpoch);
      if (root !== ethers.ZeroHash) {
        logger.info(`[EpochManager] Next epoch ${nextEpoch} already registered`);
        return;
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes('EpochNotRegistered')) {
        logger.warn(`[EpochManager] Pre-check for epoch ${nextEpoch} failed unexpectedly: ${msg}`);
      }
    }

    logger.info(`[EpochManager] Auto-registering next epoch ${nextEpoch} (current remaining: ${remaining})`);

    try {
      await this.registerEpoch(nextEpoch);
    } catch (err) {
      logger.error(`[EpochManager] Auto-registration of epoch ${nextEpoch} failed: ${(err as Error).message}`);
      this.emit('epochRegistrationFailed', { epoch: nextEpoch, error: (err as Error).message });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Status & Helpers
  // ═══════════════════════════════════════════════════════════

  async getStatus(): Promise<VRFStatus> {
    let nextEpochRegistered = false;
    if (this.vrfContractReadOnly) {
      try {
        const root = await this.vrfContractReadOnly.getEpochRoot(this.currentEpoch + 1);
        nextEpochRegistered = root !== ethers.ZeroHash;
      } catch {
        nextEpochRegistered = false;
      }
    }

    return {
      enabled: this.running,
      vrfAddress: this.config.vrfAddress,
      currentEpoch: this.currentEpoch,
      epochRemaining: this.epochRemaining,
      epochSize: this.epochSize,
      nextEpochRegistered,
      lastRegistrationTx: this.lastRegistrationTx,
      lastRegistrationEpoch: this.lastRegistrationEpoch,
      autoRegisterEnabled: this.isVrfOwner && (this.config.autoRegisterEpoch ?? true),
      vrfOwner: this.vrfOwner,
      isOwner: this.isVrfOwner,
    };
  }

  /**
   * Retry helper with exponential backoff.
   */
  private async retryAsync<T>(
    fn: () => Promise<T>,
    maxRetries: number,
    delayMs: number,
    label: string,
  ): Promise<T | undefined> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const msg = (err as Error).message;
        logger.warn(`[EpochManager] ${label} attempt ${attempt}/${maxRetries} failed: ${msg}`);

        // Don't retry if it's an "already registered" error
        if (msg.includes('EpochAlreadyRegistered') || msg.includes('Already registered')) {
          logger.info(`[EpochManager] ${label}: epoch already registered by another party`);
          return undefined;
        }

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
        }
      }
    }
    return undefined;
  }
}
