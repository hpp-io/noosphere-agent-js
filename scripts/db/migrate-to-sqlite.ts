/**
 * Migrate to SQLite Database
 *
 * Fetches all historical events from blockchain and saves to SQLite database.
 * This is a one-time migration script.
 *
 * Usage:
 *   npm run migrate:sqlite
 */

import { config as loadEnv } from 'dotenv';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { getDatabase, EventRecord } from '../../lib/db';

loadEnv();

// Extended Coordinator ABI
const COORDINATOR_ABI = [
  'event ComputeDelivered(bytes32 indexed requestId, address indexed nodeWallet, uint16 numRedundantDeliveries)',
  'event RequestStarted(bytes32 indexed requestId, uint64 indexed subscriptionId, bytes32 indexed containerId, tuple(bytes32 requestId, uint64 subscriptionId, bytes32 containerId, uint32 interval, bool useDeliveryInbox, uint16 redundancy, address walletAddress, uint256 feeAmount, address feeToken, address verifier, address coordinator) commitment)',
  'function reportComputeResult(uint32 deliveryInterval, bytes input, bytes output, bytes proof, bytes commitmentData, address nodeWallet)',
];

interface Config {
  chain: {
    rpcUrl: string;
    coordinatorAddress: string;
    deploymentBlock: number;
    wallet: {
      paymentAddress: string;
    };
  };
}

async function main() {
  console.log('🔄 Migrating to SQLite Database\n');

  // Load configuration
  const configPath = path.join(process.cwd(), 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ config.json not found');
    process.exit(1);
  }

  const config: Config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const paymentWallet = config.chain.wallet.paymentAddress;

  console.log('Configuration:');
  console.log(`  RPC URL: ${config.chain.rpcUrl}`);
  console.log(`  Coordinator: ${config.chain.coordinatorAddress}`);
  console.log(`  Deployment Block: ${config.chain.deploymentBlock}`);
  console.log(`  Payment Wallet: ${paymentWallet}\n`);

  // Connect to blockchain
  console.log('📡 Connecting to blockchain...');
  const provider = new ethers.JsonRpcProvider(config.chain.rpcUrl);
  const coordinator = new ethers.Contract(
    config.chain.coordinatorAddress,
    COORDINATOR_ABI,
    provider
  );
  console.log('✓ Connected\n');

  // Initialize database
  console.log('💾 Initializing database...');
  const db = getDatabase();
  console.log('✓ Database ready\n');

  // Query ComputeDelivered events
  console.log('📥 Fetching ComputeDelivered events...');
  const filter = coordinator.filters.ComputeDelivered(null, paymentWallet);
  const deliveredEvents = await coordinator.queryFilter(filter, config.chain.deploymentBlock);
  console.log(`✓ Found ${deliveredEvents.length} events\n`);

  if (deliveredEvents.length === 0) {
    console.log('ℹ️  No events to migrate');
    return;
  }

  // Get RequestStarted events
  console.log('📥 Fetching RequestStarted events...');
  const requestStartedFilter = coordinator.filters.RequestStarted();
  const requestStartedEvents = await coordinator.queryFilter(
    requestStartedFilter,
    config.chain.deploymentBlock
  );
  console.log(`✓ Found ${requestStartedEvents.length} RequestStarted events\n`);

  // Create requestId map
  const requestStartedMap = new Map();
  requestStartedEvents.forEach((event) => {
    const eventLog = event as any;
    const requestId = eventLog.args[0].toLowerCase();
    requestStartedMap.set(requestId, event);
  });

  // Process events
  console.log('🔄 Processing events...');
  const events: EventRecord[] = [];
  let processed = 0;
  let skipped = 0;

  for (const event of deliveredEvents) {
    processed++;
    process.stdout.write(`\r  Progress: ${processed}/${deliveredEvents.length}`);

    try {
      const eventLog = event as any;
      const requestId = eventLog.args[0];
      const requestIdKey = requestId.toLowerCase();

      // Find RequestStarted event
      const requestStartedEvent = requestStartedMap.get(requestIdKey);
      if (!requestStartedEvent) {
        skipped++;
        continue;
      }

      // Get block and transaction details
      const block = await event.getBlock();
      const receipt = await provider.getTransactionReceipt(event.transactionHash);
      const tx = await provider.getTransaction(event.transactionHash);

      if (!receipt || !tx || !block) {
        skipped++;
        continue;
      }

      // Extract commitment data
      const commitment = requestStartedEvent.args![3];
      const subscriptionId = Number(commitment.subscriptionId);
      const containerId = commitment.containerId;
      const interval = Number(commitment.interval);
      const redundancy = Number(commitment.redundancy);
      const feeAmount = commitment.feeAmount.toString();
      const feeToken = commitment.feeToken;

      // Calculate gas fee
      const gasUsed = receipt.gasUsed;
      const gasPrice = tx.gasPrice || 0n;
      const gasFee = (gasUsed * gasPrice).toString();

      // Decode input/output
      let input = '';
      let output = '';

      try {
        const iface = new ethers.Interface(COORDINATOR_ABI);
        const decoded = iface.parseTransaction({ data: tx.data });

        if (decoded && decoded.name === 'reportComputeResult') {
          input = decoded.args[1];
          output = decoded.args[2];
        }
      } catch {}

      // Extract fee earned (simplified - just use feeAmount for now)
      const feeEarned = feeAmount;
      const isPenalty = false;

      // Create event record
      events.push({
        request_id: requestId,
        subscription_id: subscriptionId,
        interval,
        block_number: event.blockNumber,
        timestamp: block.timestamp * 1000, // Convert to milliseconds
        tx_hash: event.transactionHash,
        container_id: containerId,
        redundancy,
        fee_amount: feeAmount,
        fee_token: feeToken,
        gas_fee: gasFee,
        fee_earned: feeEarned,
        is_penalty: isPenalty,
        status: 'completed' as const, // Historical events are completed
        input,
        output,
      });
    } catch (error) {
      skipped++;
      console.error(`\n  ⚠️  Error processing event: ${error}`);
    }
  }

  console.log('\n');

  // Save to database
  if (events.length > 0) {
    console.log(`💾 Saving ${events.length} events to database...`);
    db.saveEventsBatch(events);
    console.log('✓ Events saved\n');
  }

  // Print summary
  console.log('📊 Migration Summary:');
  console.log(`  Total events found: ${deliveredEvents.length}`);
  console.log(`  Successfully migrated: ${events.length}`);
  console.log(`  Skipped: ${skipped}`);
  console.log('');

  // Print stats
  const stats = db.getStats();
  console.log('📊 Database Statistics:');
  console.log(`  Total requests: ${stats.totalRequests}`);
  console.log(`  Total earned: ${ethers.formatEther(stats.totalEarned)} ETH`);
  console.log(`  Total gas: ${ethers.formatEther(stats.totalGas)} ETH`);
  console.log(`  Net profit: ${ethers.formatEther(stats.netProfit)} ETH`);
  console.log('');

  // Database size
  const dbSize = db.getSize();
  console.log(`💾 Database size: ${(dbSize / 1024).toFixed(2)} KB`);
  console.log('');

  console.log('✅ Migration complete!\n');
  console.log('Next steps:');
  console.log('  1. Restart the agent to use the new database');
  console.log('  2. Check history at http://localhost:3000/history');
  console.log('  3. Old blockchain queries will be replaced with fast DB queries\n');
}

main().catch((error) => {
  console.error('❌ Migration failed:', error);
  process.exit(1);
});
