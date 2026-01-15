import { EventEmitter } from 'events';
import {
  NoosphereAgent,
  RegistryManager,
  CheckpointData,
  ComputeDeliveredEvent,
  RequestStartedCallbackEvent,
  CommitmentSuccessCallbackEvent,
  RetryableEvent,
} from '@noosphere/agent-core';
import { getDatabase } from '../../lib/db';
import { logger } from '../../lib/logger';
import { AgentConfigFile, AgentStatus, AgentInstanceStatus } from '../types';

/**
 * Substitute ${VAR} patterns in env object with actual environment variable values
 */
function substituteEnvVars(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value.replace(/\$\{([^}]+)}/g, (match, varName) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        logger.warn(`Environment variable ${varName} is not set`);
        return match;
      }
      return envValue;
    });
  }
  return result;
}

export class AgentInstance extends EventEmitter {
  private noosphereAgent?: NoosphereAgent;
  private status: AgentStatus = 'stopped';
  private startedAt?: number;
  private lastActiveAt?: number;
  private errorMessage?: string;
  private registry?: RegistryManager;
  private containerMap = new Map<string, any>();
  private db = getDatabase();

  constructor(
    public readonly id: string,
    public readonly name: string | undefined,
    private config: AgentConfigFile,
    private keystorePassword: string,
  ) {
    super();
  }

  async initialize(): Promise<void> {
    this.status = 'starting';
    logger.info(`[${this.id}] Initializing agent...`);

    try {
      // Load registry
      this.registry = new RegistryManager({ autoSync: true, cacheTTL: 3600000 });
      await this.registry.load();

      // Build container map
      this.buildContainerMap();

      // Create NoosphereAgent (ABIs loaded from @noosphere/contracts by default)
      this.noosphereAgent = await NoosphereAgent.fromKeystore(
        this.config.chain.wallet.keystorePath,
        this.keystorePassword,
        {
          config: {
            rpcUrl: this.config.chain.rpcUrl,
            wsRpcUrl: this.config.chain.wsRpcUrl,
            routerAddress: this.config.chain.routerAddress,
            coordinatorAddress: this.config.chain.coordinatorAddress,
            deploymentBlock: this.config.chain.deploymentBlock,
          },
          containers: this.containerMap,
          paymentWallet: this.config.chain.wallet.paymentAddress,

          // Container execution configuration
          containerConfig: this.config.containerExecution,

          onRequestStarted: (event: RequestStartedCallbackEvent) => {
            this.lastActiveAt = Date.now();
            const saved = this.db.saveRequestStartedEvent({
              request_id: event.requestId,
              subscription_id: event.subscriptionId,
              interval: event.interval,
              block_number: event.blockNumber,
              container_id: event.containerId,
              redundancy: event.redundancy,
              fee_amount: event.feeAmount,
              fee_token: event.feeToken,
              verifier: event.verifier,
              wallet_address: event.walletAddress,
            });
            if (saved) {
              logger.info(`[${this.id}] RequestStarted: ${event.requestId.slice(0, 10)}...`);
              this.emit('requestStarted', { agentId: this.id, event });
            }
          },

          onRequestProcessing: (requestId: string) => {
            this.lastActiveAt = Date.now();
            this.db.updateEventToProcessing(requestId);
            logger.info(`[${this.id}] Processing: ${requestId.slice(0, 10)}...`);
          },

          onRequestSkipped: (requestId: string, reason: string) => {
            this.db.updateEventToSkipped(requestId, reason);
            logger.info(`[${this.id}] Skipped: ${requestId.slice(0, 10)}... - ${reason}`);
          },

          onRequestFailed: (requestId: string, error: string, txHash?: string) => {
            this.db.updateEventToFailed(requestId, error, txHash);
            logger.error(`[${this.id}] Failed: ${requestId.slice(0, 10)}...${txHash ? ` (tx: ${txHash.slice(0, 10)}...)` : ''} - ${error}`);
          },

          onComputeDelivered: (event: ComputeDeliveredEvent) => {
            this.lastActiveAt = Date.now();
            const gasUsed = (event.gasUsed * event.gasPrice).toString();
            this.db.updateEventToCompleted(
              event.requestId,
              event.txHash,
              gasUsed,
              event.feeAmount,
              event.input,
              event.output,
            );
            logger.info(`[${this.id}] Completed: ${event.requestId.slice(0, 10)}...`);
            this.emit('computeDelivered', { agentId: this.id, event });
          },

          onCommitmentSuccess: (event: CommitmentSuccessCallbackEvent) => {
            this.db.savePrepareTransaction({
              tx_hash: event.txHash,
              block_number: event.blockNumber,
              subscription_id: Number(event.subscriptionId),
              interval: Number(event.interval),
              gas_used: event.gasUsed,
              gas_price: event.gasPrice,
              gas_cost: event.gasCost,
              status: 'success',
            });
          },

          isRequestProcessed: (requestId: string) => this.db.isEventProcessed(requestId),

          loadCheckpoint: (): CheckpointData | undefined => {
            const checkpoint = this.db.getLatestCheckpoint('event_monitor');
            if (checkpoint) {
              return {
                blockNumber: checkpoint.block_number,
                blockHash: checkpoint.block_hash || undefined,
                blockTimestamp: checkpoint.block_timestamp || undefined,
              };
            }
            return undefined;
          },

          saveCheckpoint: (checkpoint: CheckpointData) => {
            this.db.saveCheckpoint({
              block_number: checkpoint.blockNumber,
              block_hash: checkpoint.blockHash,
              block_timestamp: checkpoint.blockTimestamp,
              checkpoint_type: 'event_monitor',
            });
          },

          getContainer: (containerId: string) => {
            if (containerId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
              return undefined;
            }
            // Direct lookup by hash ID (config now uses same hash as blockchain)
            const configContainer = this.containerMap.get(containerId);
            if (!configContainer) return undefined;

            return {
              id: containerId,
              name: configContainer.name,
              image: configContainer.image,
              tag: configContainer.tag || 'latest',
              port: configContainer.port,
            };
          },

          schedulerConfig: {
            cronIntervalMs: this.config.scheduler?.cronIntervalMs ?? 60000,
            syncPeriodMs: this.config.scheduler?.syncPeriodMs ?? 3000,
            maxRetryAttempts: 3,
            loadCommittedIntervals: () => this.db.getCommittedIntervalKeys(),
            saveCommittedInterval: () => {},
          },

          // Retry configuration
          maxRetries: this.config.retry?.maxRetries ?? 3,
          retryIntervalMs: this.config.retry?.retryIntervalMs ?? 30000,

          getRetryableEvents: (maxRetries: number): RetryableEvent[] => {
            const events = this.db.getRetryableEvents(maxRetries);
            return events.map(e => ({
              requestId: e.request_id,
              subscriptionId: e.subscription_id,
              interval: e.interval,
              containerId: e.container_id,
              retryCount: e.retry_count,
            }));
          },

          resetEventForRetry: (requestId: string) => {
            this.db.resetEventForRetry(requestId);
          },
        },
      );

      logger.info(`[${this.id}] Agent initialized`);
    } catch (error) {
      this.status = 'error';
      this.errorMessage = (error as Error).message;
      throw error;
    }
  }

  async start(): Promise<void> {
    if (!this.noosphereAgent) throw new Error('Agent not initialized');

    logger.info(`[${this.id}] Starting agent...`);
    await this.noosphereAgent.start();
    this.status = 'running';
    this.startedAt = Date.now();
    this.lastActiveAt = Date.now();
    this.db.fixInconsistentEventStatuses();
    logger.info(`[${this.id}] Agent started`);
    this.emit('started', { agentId: this.id });
  }

  async stop(): Promise<void> {
    if (!this.noosphereAgent) return;
    this.status = 'stopping';
    logger.info(`[${this.id}] Stopping agent...`);
    await this.noosphereAgent.stop();
    this.status = 'stopped';
    logger.info(`[${this.id}] Agent stopped`);
    this.emit('stopped', { agentId: this.id });
  }

  getStatus(): AgentInstanceStatus {
    const agentStatus = this.noosphereAgent?.getStatus();
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      address: agentStatus?.address,
      running: this.status === 'running',
      containers: { runningCount: agentStatus?.containers.runningCount ?? 0 },
      scheduler: {
        totalSubscriptions: agentStatus?.scheduler.totalSubscriptions ?? 0,
        activeSubscriptions: agentStatus?.scheduler.activeSubscriptions ?? 0,
        pendingTransactions: agentStatus?.scheduler.pendingTransactions ?? 0,
      },
      error: this.errorMessage,
      startedAt: this.startedAt,
      lastActiveAt: this.lastActiveAt,
    };
  }

  private buildContainerMap(): void {
    if (this.config.containers) {
      for (const container of this.config.containers) {
        const [image, tag] = container.image.includes(':')
          ? container.image.split(':')
          : [container.image, 'latest'];
        // Use hash ID as key, name for display
        this.containerMap.set(container.id, {
          id: container.id,
          name: container.name || container.id.slice(0, 10),
          image,
          tag,
          port: container.port,
          env: substituteEnvVars(container.env),
        });
      }
    }

    if (this.config.verifiers) {
      for (const verifier of this.config.verifiers) {
        if (verifier.requiresProof && verifier.proofService) {
          const containerId = `proof-service-${verifier.id}`;
          const [image, tag] = verifier.proofService.image.includes(':')
            ? verifier.proofService.image.split(':')
            : [verifier.proofService.image, 'latest'];
          this.containerMap.set(containerId, {
            id: containerId,
            name: containerId, // Use valid Docker name (no spaces/colons)
            image,
            tag,
            port: verifier.proofService.port,
            env: substituteEnvVars(verifier.proofService.env),
            command: verifier.proofService.command,
          });
        }
      }
    }

    logger.info(`[${this.id}] Loaded ${this.containerMap.size} containers`);
  }
}
