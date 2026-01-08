/**
 * Run Noosphere Agent from config.json
 */

import 'dotenv/config';
import { NoosphereAgent, ContainerManager, ComputeDeliveredEvent, RequestStartedCallbackEvent, CommitmentSuccessCallbackEvent, CheckpointData } from '@noosphere/agent-core';
import { RegistryManager } from '@noosphere/registry';
import { getDatabase } from './lib/db';
import { logger, LogLevel } from './lib/logger';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
const SYNC_ON_STARTUP = process.argv.includes('--sync') || process.env.SYNC_ON_STARTUP === 'true';

/**
 * Sync missing events from blockchain to DB
 * This backfills any events that exist on-chain but not in local DB
 */
async function syncMissingEvents(
  coordinatorAddress: string,
  coordinatorAbi: any[],
  rpcUrl: string,
  deploymentBlock: number
): Promise<void> {
  logger.info('Syncing missing events from blockchain...');

  const db = getDatabase();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const coordinator = new ethers.Contract(coordinatorAddress, coordinatorAbi, provider);

  // Get starting block from DB checkpoint
  const checkpoint = db.getLatestCheckpoint();
  const fromBlock = checkpoint?.block_number || deploymentBlock || 0;
  const currentBlock = await provider.getBlockNumber();

  logger.info(`From block: ${fromBlock}`);
  logger.info(`To block: ${currentBlock}`);
  logger.info(`Blocks to scan: ${currentBlock - fromBlock}`);

  // Query blockchain events in chunks
  const chunkSize = 10000;
  let totalSynced = 0;

  for (let start = fromBlock; start <= currentBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, currentBlock);

    const events = await coordinator.queryFilter(
      coordinator.filters.RequestStarted(),
      start,
      end
    );

    for (const event of events) {
      const eventLog = event as any;
      const requestId = eventLog.args.requestId;
      const commitment = eventLog.args.commitment;

      // Check if event exists in DB
      if (db.eventExists(requestId)) {
        continue;
      }

      // Insert missing event
      const saved = db.saveRequestStartedEvent({
        request_id: requestId,
        subscription_id: Number(eventLog.args.subscriptionId),
        interval: Number(commitment.interval),
        block_number: event.blockNumber || 0,
        container_id: eventLog.args.containerId,
        redundancy: Number(commitment.redundancy),
        fee_amount: commitment.feeAmount.toString(),
        fee_token: commitment.feeToken,
        verifier: commitment.verifier,
        wallet_address: commitment.walletAddress,
      });

      if (saved) {
        logger.info(`Synced: ${requestId.slice(0, 16)}... (Sub: ${eventLog.args.subscriptionId}, Interval: ${commitment.interval})`);
        totalSynced++;
      }
    }
  }

  if (totalSynced > 0) {
    logger.info(`Synced ${totalSynced} missing events`);
  } else {
    logger.info('DB is in sync with blockchain');
  }
}

// Load ABIs
// These paths can be customized via environment variables
const routerAbiPath = process.env.ROUTER_ABI_PATH ||
  path.join(__dirname, '../noosphere-evm/out/Router.sol/Router.abi.json');
const coordinatorAbiPath = process.env.COORDINATOR_ABI_PATH ||
  path.join(__dirname, '../noosphere-evm/out/Coordinator.sol/Coordinator.abi.json');

async function main() {
  try {
    logger.info('Starting Noosphere Agent from config.json...');

    // Load ABIs
    logger.info('Loading contract ABIs...');
    const routerAbi = JSON.parse(fs.readFileSync(routerAbiPath, 'utf-8'));
    const coordinatorAbi = JSON.parse(fs.readFileSync(coordinatorAbiPath, 'utf-8'));
    logger.info('ABIs loaded');

    // Load configuration
    const configPath = path.join(__dirname, 'config.json');
    logger.info(`Loading config from: ${configPath}`);
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Configure logger from config
    const logLevel = (configData.logging?.level || 'info') as LogLevel;
    logger.configure({ level: logLevel });
    logger.info(`Log level: ${logLevel}`);

    // Get password from environment
    const password = process.env.KEYSTORE_PASSWORD;
    if (!password) {
      throw new Error('KEYSTORE_PASSWORD environment variable is required');
    }

    logger.info('Configuration:');
    logger.raw(`  Keystore: ${configData.chain.wallet.keystorePath}`);
    logger.raw(`  RPC URL: ${configData.chain.rpcUrl}`);
    logger.raw(`  Router: ${configData.chain.routerAddress}`);
    logger.raw(`  Coordinator: ${configData.chain.coordinatorAddress}`);
    logger.raw(`  Deployment Block: ${configData.chain.deploymentBlock}`);

    // Load container registry
    logger.info('Loading container registry...');
    const registry = new RegistryManager({
      autoSync: true,
      cacheTTL: 3600000, // 1 hour
    });
    await registry.load();

    const stats = registry.getStats();
    logger.info('Registry loaded:');
    logger.raw(`  Containers: ${stats.totalContainers} (${stats.activeContainers} active)`);
    logger.raw(`  Verifiers: ${stats.totalVerifiers} (${stats.activeVerifiers} active)`);

    // Build container map from config.json
    const containerMap = new Map();
    if (configData.containers && Array.isArray(configData.containers)) {
      for (const container of configData.containers) {
        // Split image and tag if present
        const [image, tag] = container.image.includes(':')
          ? container.image.split(':')
          : [container.image, 'latest'];

        containerMap.set(container.id, {
          id: container.id,
          name: container.id,
          image,
          tag,
          port: container.port,
          env: container.env,
        });
      }
      logger.info(`Loaded ${containerMap.size} containers from config.json`);
    }

    // Add verifier proof service containers to containerMap
    if (configData.verifiers && Array.isArray(configData.verifiers)) {
      logger.info('Loading verifier proof services from config.json...');
      let proofServiceCount = 0;

      for (const verifier of configData.verifiers) {
        if (verifier.requiresProof && verifier.proofService) {
          const proofService = verifier.proofService;
          const containerId = `proof-service-${verifier.id}`;

          // Split image and tag if present
          const [image, tag] = proofService.image.includes(':')
            ? proofService.image.split(':')
            : [proofService.image, 'latest'];

          containerMap.set(containerId, {
            id: containerId,
            name: `Proof Service: ${verifier.name}`,
            image,
            tag,
            port: proofService.port,
            env: proofService.env,
            command: proofService.command,
          });
          proofServiceCount++;
        }
      }

      if (proofServiceCount > 0) {
        logger.info(`Loaded ${proofServiceCount} proof service containers`);
      }
    }

    // Create ContainerManager for cleanup on shutdown
    const containerManager = new ContainerManager();

    // Initialize agent from keystore
    logger.info('Loading agent from keystore...');
    const agent = await NoosphereAgent.fromKeystore(
      configData.chain.wallet.keystorePath,
      password,
      {
        config: {
          rpcUrl: configData.chain.rpcUrl,
          wsRpcUrl: configData.chain.wsRpcUrl || undefined,
          routerAddress: configData.chain.routerAddress,
          coordinatorAddress: configData.chain.coordinatorAddress,
          deploymentBlock: configData.chain.deploymentBlock,
        },
        routerAbi,
        coordinatorAbi,
        containers: containerMap,
        paymentWallet: configData.chain.wallet.paymentAddress,
        onRequestStarted: (event: RequestStartedCallbackEvent) => {
          // Save RequestStarted event to database (pending status)
          const db = getDatabase();
          const saved = db.saveRequestStartedEvent({
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
            logger.info(`RequestStarted saved: ${event.requestId.slice(0, 10)}...`);
          }
        },
        onRequestProcessing: (requestId: string) => {
          // Update event status to processing
          const db = getDatabase();
          db.updateEventToProcessing(requestId);
          logger.info(`Processing: ${requestId.slice(0, 10)}...`);
        },
        onRequestSkipped: (requestId: string, reason: string) => {
          // Update event status to skipped
          const db = getDatabase();
          db.updateEventToSkipped(requestId, reason);
          logger.info(`Skipped: ${requestId.slice(0, 10)}... - ${reason}`);
        },
        onRequestFailed: (requestId: string, error: string) => {
          // Update event status to failed
          const db = getDatabase();
          db.updateEventToFailed(requestId, error);
          logger.error(`Failed: ${requestId.slice(0, 10)}... - ${error}`);
        },
        onComputeDelivered: (event: ComputeDeliveredEvent) => {
          // Update event to completed with delivery details
          const db = getDatabase();
          const gasUsed = (event.gasUsed * event.gasPrice).toString();
          db.updateEventToCompleted(
            event.requestId,
            event.txHash,
            gasUsed,
            event.feeAmount,
            event.input,
            event.output
          );
          logger.info(`Completed: ${event.requestId.slice(0, 10)}... (tx: ${event.txHash.slice(0, 10)}...)`);
        },
        onCommitmentSuccess: (event: CommitmentSuccessCallbackEvent) => {
          // Save prepare transaction to database (for tracking gas costs)
          const db = getDatabase();
          const saved = db.savePrepareTransaction({
            tx_hash: event.txHash,
            block_number: event.blockNumber,
            subscription_id: Number(event.subscriptionId),
            interval: Number(event.interval),
            gas_used: event.gasUsed,
            gas_price: event.gasPrice,
            gas_cost: event.gasCost,
            status: 'success',
          });
          if (saved) {
            logger.info(`Prepare tx saved: ${event.txHash.slice(0, 10)}... (Sub: ${event.subscriptionId}, Interval: ${event.interval})`);
          }
        },
        isRequestProcessed: (requestId: string) => {
          // Check if request has already been processed (completed/failed/skipped)
          // This prevents duplicate processing during event replay
          const db = getDatabase();
          return db.isEventProcessed(requestId);
        },
        loadCheckpoint: (): CheckpointData | undefined => {
          // Load checkpoint from database
          const db = getDatabase();
          const checkpoint = db.getLatestCheckpoint('event_monitor');
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
          // Save checkpoint to database
          const db = getDatabase();
          db.saveCheckpoint({
            block_number: checkpoint.blockNumber,
            block_hash: checkpoint.blockHash,
            block_timestamp: checkpoint.blockTimestamp,
            checkpoint_type: 'event_monitor',
          });
        },
        getContainer: (containerId) => {
          // Skip cancelled/deleted subscriptions (containerId = 0x0000...0)
          if (containerId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
            return undefined;
          }

          // 1. Get container from registry (containerId is a hash, need to get name)
          const container = registry.getContainer(containerId);
          if (!container) {
            // Not in registry
            logger.debug(`Container not in registry: ${containerId.slice(0, 16)}...`);
            return undefined;
          }

          // 2. Check if container is in config.json (local control)
          // Match by name (registry uses hash as id, config uses string name as id)
          const configContainer = containerMap.get(container.name);
          if (!configContainer) {
            // Container exists in registry but not in config
            logger.debug(`Container "${container.name}" not in config.json`);
            return undefined;
          }

          // 3. Both conditions met -> supported
          logger.info(`Container "${container.name}" supported (scheduler check)`);
          return {
            id: container.id,
            name: container.name,
            image: container.imageName,
            tag: 'latest',
            port: configContainer.port,
            requirements: container.requirements,
            payments: container.payments ? {
              basePrice: container.payments.basePrice,
              unit: container.payments.token,
              per: container.payments.per,
            } : undefined,
            verified: container.verified,
          };
        },
        schedulerConfig: {
          cronIntervalMs: configData.scheduler?.cronIntervalMs ?? 60000,
          syncPeriodMs: configData.scheduler?.syncPeriodMs ?? 3000,
          maxRetryAttempts: 3,
          loadCommittedIntervals: () => {
            // Load committed intervals from database on startup
            const db = getDatabase();
            return db.getCommittedIntervalKeys();
          },
          saveCommittedInterval: (_key: string) => {
            // No-op - committed intervals are tracked via events table
            // The actual save happens in onRequestStarted callback
          },
        },
      }
    );

    logger.info('Agent initialized from keystore');

    logger.info('Starting agent...');

    // Start the agent
    await agent.start();

    // Initialize database and fix any inconsistent statuses from previous runs
    const db = getDatabase();
    logger.info('Database initialized');

    // Fix events that have tx_hash but wrong status (from race conditions or crashes)
    db.fixInconsistentEventStatuses();

    // Sync missing events from blockchain (optional, enabled with --sync flag or SYNC_ON_STARTUP=true)
    if (SYNC_ON_STARTUP) {
      await syncMissingEvents(
        configData.chain.coordinatorAddress,
        coordinatorAbi,
        configData.chain.rpcUrl,
        configData.chain.deploymentBlock
      );
    }

    // Log status every 30 seconds to database
    const writeStatus = () => {
      const status = agent.getStatus();
      const eventStats = db.getEventStats();

      console.log(`\n📊 Agent Status [${new Date().toISOString()}]:`);
      console.log(`  Running: ${status.running}`);
      console.log(`  Address: ${status.address}`);
      console.log(`  Containers: ${status.containers.runningCount} running`);
      console.log(`  Scheduler (Scheduled Subscriptions):`);
      console.log(`    - Tracking: ${status.scheduler.totalSubscriptions}`);
      console.log(`    - Active: ${status.scheduler.activeSubscriptions}`);
      console.log(`    - Pending Txs: ${status.scheduler.pendingTransactions}`);
      console.log(`  Events (All Requests):`);
      console.log(`    - Total: ${eventStats.total} (✓${eventStats.completed} ✗${eventStats.failed} ⏭${eventStats.skipped} ⏰${eventStats.expired})`);

      // Save to database
      db.logAgentStatus({
        running: status.running,
        address: status.address,
        containers_running: status.containers.runningCount,
        total_subscriptions: status.scheduler.totalSubscriptions,
        active_subscriptions: status.scheduler.activeSubscriptions,
        committed_intervals: eventStats.completed, // Use completed count instead
        pending_transactions: status.scheduler.pendingTransactions,
      });
    };

    // Write status immediately and then every 30 seconds
    writeStatus();
    const statusInterval = setInterval(writeStatus, 30000);

    // Handle shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down agent...');
      clearInterval(statusInterval);
      await agent.stop();
      logger.info('Stopping Docker containers...');
      await containerManager.stopPersistentContainers();
      logger.info('Agent stopped successfully');
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Shutting down agent...');
      clearInterval(statusInterval);
      await agent.stop();
      logger.info('Stopping Docker containers...');
      await containerManager.stopPersistentContainers();
      logger.info('Agent stopped successfully');
      process.exit(0);
    });

    // Keep process alive
    logger.raw('\n💡 Agent is running. Press Ctrl+C to stop.\n');

  } catch (error) {
    const err = error as Error;
    logger.error(`Error starting agent: ${err.message}`);
    if (err.stack) {
      logger.raw('\nStack trace:');
      logger.raw(err.stack);
    }
    process.exit(1);
  }
}

main();
