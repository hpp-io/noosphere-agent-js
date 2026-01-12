/**
 * Sync Missing Events from Blockchain
 *
 * Backfills events from blockchain to local DB:
 * 1. RequestStarted events - creates pending entries
 * 2. ComputeDelivered events - updates to completed status
 * 3. Expired detection - marks old pending requests as expired
 * 4. PrepareTransactions - syncs agent's prepare transactions
 *
 * Usage:
 *   tsx scripts/db/sync-from-blockchain.ts              # Sync from last DB checkpoint
 *   tsx scripts/db/sync-from-blockchain.ts --from 1000  # Sync from specific block
 *   tsx scripts/db/sync-from-blockchain.ts --full       # Full sync from deployment
 */

import { config as loadEnv } from 'dotenv';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { ABIs } from '@noosphere/contracts';
import { getDatabase } from '../../lib/db';

loadEnv();

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const result: { from?: number; full?: boolean; dryRun?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) {
      result.from = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--full') {
      result.full = true;
    } else if (args[i] === '--dry-run') {
      result.dryRun = true;
    }
  }

  return result;
}

async function main() {
  console.log('🔄 Blockchain to DB Sync Tool\n');

  const args = parseArgs();
  const db = getDatabase();

  // Load config
  const configPath = path.join(process.cwd(), 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ config.json not found');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Get my payment wallet address for filtering
  const myPaymentWallet = config.chain.wallet.paymentAddress?.toLowerCase();
  if (!myPaymentWallet) {
    console.error('❌ paymentAddress not found in config.json');
    process.exit(1);
  }
  console.log(`🔑 Filtering events for wallet: ${myPaymentWallet}\n`);

  // Use ABI from @noosphere/contracts
  const coordinatorAbi = ABIs.Coordinator;

  // Setup provider
  const provider = new ethers.JsonRpcProvider(config.chain.rpcUrl);
  const coordinator = new ethers.Contract(
    config.chain.coordinatorAddress,
    coordinatorAbi,
    provider
  );

  // Determine starting block
  let fromBlock: number;

  if (args.full) {
    fromBlock = config.chain.deploymentBlock || 0;
    console.log(`📊 Full sync from deployment block ${fromBlock}`);
  } else if (args.from !== undefined) {
    fromBlock = args.from;
    console.log(`📊 Sync from specified block ${fromBlock}`);
  } else {
    // Use DB checkpoint
    const checkpoint = db.getLatestCheckpoint();
    if (checkpoint) {
      fromBlock = checkpoint.block_number;
      console.log(`📊 Sync from DB checkpoint block ${fromBlock}`);
    } else {
      fromBlock = config.chain.deploymentBlock || 0;
      console.log(`📊 No checkpoint found, sync from deployment block ${fromBlock}`);
    }
  }

  const currentBlock = await provider.getBlockNumber();
  console.log(`📊 Current block: ${currentBlock}`);
  console.log(`📊 Blocks to scan: ${currentBlock - fromBlock}\n`);

  if (args.dryRun) {
    console.log('⚠️  DRY RUN MODE - No changes will be made\n');
  }

  // ==================== Phase 1: Sync RequestStarted Events ====================
  console.log('📥 Phase 1: Syncing RequestStarted events...\n');

  const chunkSize = 10000;
  let requestsOnChain = 0;
  let requestsMissing = 0;
  let requestsSynced = 0;

  for (let start = fromBlock; start <= currentBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, currentBlock);

    const events = await coordinator.queryFilter(
      coordinator.filters.RequestStarted(),
      start,
      end
    );

    if (events.length === 0) continue;

    console.log(`  🔍 Blocks ${start}-${end}: ${events.length} RequestStarted events`);

    for (const event of events) {
      const eventLog = event as any;
      const requestId = eventLog.args.requestId;
      const commitment = eventLog.args.commitment;

      // Filter: only sync events for my payment wallet
      if (commitment.walletAddress.toLowerCase() !== myPaymentWallet) {
        continue;
      }

      requestsOnChain++;

      // Check if event exists in DB
      const existingEvent = db.getEvent(requestId);
      if (existingEvent) continue;

      requestsMissing++;

      if (!args.dryRun) {
        // Get block timestamp for accurate event time
        const block = await provider.getBlock(event.blockNumber);
        const blockTimestamp = block ? block.timestamp * 1000 : Date.now(); // Convert to ms

        const saved = db.saveRequestStartedEventWithTimestamp({
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
        }, blockTimestamp);

        if (saved) {
          requestsSynced++;
        }
      }
    }
  }

  console.log(`\n  ✓ RequestStarted: ${requestsOnChain} for my wallet, ${requestsMissing} missing, ${requestsSynced} synced\n`);

  // ==================== Phase 2: Sync ComputeDelivered Events ====================
  console.log('📥 Phase 2: Syncing ComputeDelivered events...\n');

  let deliveriesOnChain = 0;
  let deliveriesUpdated = 0;
  let deliveriesAlreadyComplete = 0;

  for (let start = fromBlock; start <= currentBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, currentBlock);

    const events = await coordinator.queryFilter(
      coordinator.filters.ComputeDelivered(),
      start,
      end
    );

    if (events.length === 0) continue;

    console.log(`  🔍 Blocks ${start}-${end}: ${events.length} ComputeDelivered events`);
    deliveriesOnChain += events.length;

    for (const event of events) {
      const eventLog = event as any;
      const requestId = eventLog.args.requestId;
      const txHash = event.transactionHash;

      // Check if event exists in DB and is not already completed
      const existingEvent = db.getEvent(requestId);

      if (!existingEvent) {
        // Request not in DB, skip (will be synced in next run)
        continue;
      }

      // Skip if already completed AND has valid gas_fee
      if (existingEvent.status === 'completed' && existingEvent.gas_fee && existingEvent.gas_fee !== '0') {
        deliveriesAlreadyComplete++;
        continue;
      }

      deliveriesUpdated++;

      if (!args.dryRun) {
        // Get transaction receipt for gas info
        const receipt = await provider.getTransactionReceipt(txHash);
        const gasUsed = receipt?.gasUsed?.toString() || '0';
        // Use effectiveGasPrice (ethers v6) or fall back to gasPrice
        const gasPrice = (receipt as any)?.effectiveGasPrice?.toString() || receipt?.gasPrice?.toString() || '0';
        const gasFee = (BigInt(gasUsed) * BigInt(gasPrice)).toString();

        // Update event to completed
        db.updateEventToCompleted(
          requestId,
          txHash,
          gasFee,
          existingEvent.fee_amount, // feeEarned = feeAmount for now
          existingEvent.input || '',
          existingEvent.output || ''
        );

        console.log(`    ✓ Completed: ${requestId.slice(0, 16)}... (tx: ${txHash.slice(0, 12)}...)`);
      }
    }
  }

  console.log(`\n  ✓ ComputeDelivered: ${deliveriesOnChain} on-chain, ${deliveriesUpdated} updated, ${deliveriesAlreadyComplete} already complete\n`);

  // ==================== Phase 3: Mark Expired Requests ====================
  console.log('📥 Phase 3: Checking for expired requests...\n');

  // Get all pending events
  const pendingResult = db.getEvents(1000, 0, { status: 'pending' });
  const pendingEvents = pendingResult.data;

  let expiredCount = 0;
  const now = Date.now();

  // For scheduled requests: if the event was created more than 1 hour ago and still pending, mark as expired
  // This is a simple heuristic - in production you'd check against subscription interval
  const EXPIRY_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

  for (const event of pendingEvents) {
    const eventAge = now - event.timestamp;

    if (eventAge > EXPIRY_THRESHOLD_MS) {
      if (!args.dryRun) {
        db.updateEventToExpired(event.request_id, 'Interval deadline passed');
      }
      expiredCount++;
      console.log(`  ⏰ Expired: Sub ${event.subscription_id}, Interval ${event.interval} (${Math.floor(eventAge / 60000)}min old)`);
    }
  }

  if (expiredCount === 0) {
    console.log('  ✓ No expired requests found\n');
  } else {
    console.log(`\n  ✓ Marked ${expiredCount} requests as expired\n`);
  }

  // ==================== Phase 4: Sync Prepare Transactions ====================
  console.log('📥 Phase 4: Syncing PrepareTransactions...\n');

  // Get agent address from keystore (try multiple paths for Docker compatibility)
  let agentAddress = '';
  const keystorePaths = [
    config.chain.wallet.keystorePath,
    path.join(process.env.NOOSPHERE_DATA_DIR || '.noosphere', 'keystore.json'),
    '.noosphere/keystore.json',
  ];

  for (const keystorePath of keystorePaths) {
    try {
      const fullPath = path.isAbsolute(keystorePath) ? keystorePath : path.join(process.cwd(), keystorePath);
      const keystoreData = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
      agentAddress = keystoreData.eoa?.address?.toLowerCase() || '';
      if (agentAddress) {
        console.log(`  Found keystore at: ${fullPath}`);
        break;
      }
    } catch {
      // Try next path
    }
  }

  if (!agentAddress) {
    console.log('  ⚠️  Could not read agent address from keystore, skipping prepare sync\n');
  }

  let prepareOnChain = 0;
  let prepareSynced = 0;
  let prepareAlreadyExists = 0;

  // prepareNextInterval(uint64,uint32,address) function selector
  const PREPARE_NEXT_INTERVAL_SELECTOR = '0xf5e5a31a';
  const coordinatorAddressLower = config.chain.coordinatorAddress.toLowerCase();

  if (agentAddress) {
    console.log(`  Agent address: ${agentAddress}`);
    console.log(`  Coordinator: ${coordinatorAddressLower}\n`);

    // Pre-load existing prepare transaction hashes for efficiency
    const existingPrepares = new Set<string>();
    const allPrepares = db.getPrepareTransactions(10000, 0);
    allPrepares.data.forEach((p: any) => existingPrepares.add(p.tx_hash));

    // Find RequestStarted events where the transaction is prepareNextInterval to Coordinator
    for (let start = fromBlock; start <= currentBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, currentBlock);

      const events = await coordinator.queryFilter(
        coordinator.filters.RequestStarted(),
        start,
        end
      );

      if (events.length === 0) continue;

      for (const event of events) {
        const txHash = event.transactionHash;

        // Get transaction to check if it's a direct prepareNextInterval call to Coordinator
        const tx = await provider.getTransaction(txHash);
        if (!tx) continue;

        // Must be sent FROM our agent
        if (tx.from?.toLowerCase() !== agentAddress) {
          continue;
        }

        // Must be sent TO the Coordinator contract
        if (tx.to?.toLowerCase() !== coordinatorAddressLower) {
          continue;
        }

        // Must be prepareNextInterval function call
        if (!tx.data.startsWith(PREPARE_NEXT_INTERVAL_SELECTOR)) {
          continue;
        }

        prepareOnChain++;

        // Check if already in prepare_transactions
        if (existingPrepares.has(txHash)) {
          prepareAlreadyExists++;
          continue;
        }

        prepareSynced++;

        if (!args.dryRun) {
          // Get transaction receipt for gas info
          const receipt = await provider.getTransactionReceipt(txHash);
          const gasUsed = receipt?.gasUsed?.toString() || '0';
          const gasPrice = (receipt as any)?.effectiveGasPrice?.toString() || receipt?.gasPrice?.toString() || '0';
          const gasCost = (BigInt(gasUsed) * BigInt(gasPrice)).toString();

          const eventLog = event as any;
          const commitment = eventLog.args.commitment;

          db.savePrepareTransaction({
            tx_hash: txHash,
            block_number: event.blockNumber || 0,
            subscription_id: Number(eventLog.args.subscriptionId),
            interval: Number(commitment.interval),
            gas_used: gasUsed,
            gas_price: gasPrice,
            gas_cost: gasCost,
            status: 'success',
          });

          console.log(`    ✓ Prepare: Sub ${eventLog.args.subscriptionId}, Interval ${commitment.interval} (tx: ${txHash.slice(0, 12)}...)`);
        }
      }
    }
  }

  console.log(`\n  ✓ PrepareTransactions: ${prepareOnChain} from agent, ${prepareSynced} synced, ${prepareAlreadyExists} already exist\n`);

  // ==================== Summary ====================
  console.log('='.repeat(50));
  console.log('📊 Sync Summary (filtered by my wallet)');
  console.log('='.repeat(50));
  console.log(`  RequestStarted:      ${requestsOnChain} for my wallet, ${requestsSynced} synced`);
  console.log(`  ComputeDelivered:    ${deliveriesOnChain} in DB, ${deliveriesUpdated} updated`);
  console.log(`  Expired:             ${expiredCount} marked`);
  console.log(`  PrepareTransactions: ${prepareOnChain} from agent, ${prepareSynced} synced`);
  console.log('='.repeat(50));

  if (args.dryRun) {
    console.log('\n💡 Run without --dry-run to apply changes');
  } else {
    console.log('\n✅ Sync complete!');
  }
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
