import { EventEmitter } from 'events';
import {
  NoosphereAgent,
  RegistryManager,
  CheckpointData,
  ComputeDeliveredEvent,
  RequestStartedCallbackEvent,
  CommitmentSuccessCallbackEvent,
} from '@noosphere/agent-core';
import { getDatabase } from '../../lib/db';
import { logger } from '../../lib/logger';
import { AgentConfigFile, AgentStatus, AgentInstanceStatus } from '../types';

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

          onRequestFailed: (requestId: string, error: string) => {
            this.db.updateEventToFailed(requestId, error);
            logger.error(`[${this.id}] Failed: ${requestId.slice(0, 10)}... - ${error}`);
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
            const container = this.registry?.getContainer(containerId);
            if (!container) return undefined;

            const configContainer = this.containerMap.get(container.name);
            if (!configContainer) return undefined;

            return {
              id: container.id,
              name: container.name,
              image: container.imageName,
              tag: 'latest',
              port: configContainer.port,
              requirements: container.requirements,
              payments: container.payments
                ? { basePrice: container.payments.basePrice, unit: container.payments.token, per: container.payments.per }
                : undefined,
              verified: container.verified,
            };
          },

          schedulerConfig: {
            cronIntervalMs: this.config.scheduler?.cronIntervalMs ?? 60000,
            syncPeriodMs: this.config.scheduler?.syncPeriodMs ?? 3000,
            maxRetryAttempts: 3,
            loadCommittedIntervals: () => this.db.getCommittedIntervalKeys(),
            saveCommittedInterval: () => {},
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
        this.containerMap.set(container.id, { id: container.id, name: container.id, image, tag, port: container.port, env: container.env });
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
            name: `Proof Service: ${verifier.name}`,
            image,
            tag,
            port: verifier.proofService.port,
            env: verifier.proofService.env,
            command: verifier.proofService.command,
          });
        }
      }
    }

    logger.info(`[${this.id}] Loaded ${this.containerMap.size} containers`);
  }
}
