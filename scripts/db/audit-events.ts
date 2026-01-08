/**
 * Event Audit Tool
 *
 * Compares blockchain events with agent's checkpoint to detect missing events.
 * Helps identify if the agent missed any RequestStarted events.
 *
 * Usage:
 *   tsx scripts/audit-events.ts
 *   tsx scripts/audit-events.ts --from 12000 --to 13000
 */

import { config as loadEnv } from 'dotenv';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

loadEnv();

interface Checkpoint {
  lastProcessedBlock: number;
  timestamp: number;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result: { from?: number; to?: number | string } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) {
      result.from = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--to' && args[i + 1]) {
      result.to = args[i + 1] === 'latest' ? 'latest' : parseInt(args[i + 1]);
      i++;
    }
  }

  return result;
}

async function main() {
  console.log('🔍 Event Audit Tool\n');

  const args = parseArgs();

  // Load config
  const configPath = path.join(process.cwd(), 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ config.json not found');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Load checkpoint
  const checkpointPath = path.join(process.cwd(), '.noosphere', 'checkpoint.json');
  let checkpoint: Checkpoint;

  try {
    checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
    console.log('📋 Current checkpoint:');
    console.log(`  Block: ${checkpoint.lastProcessedBlock}`);
    console.log(`  Time: ${new Date(checkpoint.timestamp).toISOString()}\n`);
  } catch {
    console.warn('⚠️  No checkpoint found, using deployment block\n');
    checkpoint = {
      lastProcessedBlock: config.chain.deploymentBlock || 0,
      timestamp: Date.now(),
    };
  }

  // Load ABIs
  const coordinatorAbiPath = process.env.COORDINATOR_ABI_PATH ||
    path.join(process.cwd(), '../noosphere-evm/out/Coordinator.sol/Coordinator.abi.json');
  const coordinatorAbi = JSON.parse(fs.readFileSync(coordinatorAbiPath, 'utf-8'));

  // Setup provider
  const provider = new ethers.JsonRpcProvider(config.chain.rpcUrl);
  const coordinator = new ethers.Contract(
    config.chain.coordinatorAddress,
    coordinatorAbi,
    provider
  );

  // Determine block range
  const fromBlock = args.from || config.chain.deploymentBlock || 0;
  const currentBlock = await provider.getBlockNumber();
  const toBlock = args.to === 'latest' || !args.to ? currentBlock : Number(args.to);

  console.log(`📊 Auditing blocks ${fromBlock} to ${toBlock}\n`);

  // Query all events from blockchain
  console.log('🔍 Querying blockchain events...');
  const chunkSize = 10000;
  const allEvents: any[] = [];

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);

    process.stdout.write(`  Blocks ${start} to ${end}... `);

    const events = await coordinator.queryFilter(
      coordinator.filters.RequestStarted(),
      start,
      end
    );

    allEvents.push(...events);
    console.log(`${events.length} events`);
  }

  console.log(`\n✓ Found ${allEvents.length} total events on blockchain\n`);

  // Analyze results
  console.log('📊 Analysis:\n');

  // Events before checkpoint (should be processed)
  const eventsBeforeCheckpoint = allEvents.filter(
    e => e.blockNumber <= checkpoint.lastProcessedBlock
  );

  // Events after checkpoint (expected to be unprocessed)
  const eventsAfterCheckpoint = allEvents.filter(
    e => e.blockNumber > checkpoint.lastProcessedBlock
  );

  console.log(`  Events before checkpoint (block ${checkpoint.lastProcessedBlock}):`);
  console.log(`    Total: ${eventsBeforeCheckpoint.length}`);
  console.log(`    Status: Should be processed by agent\n`);

  console.log(`  Events after checkpoint:`);
  console.log(`    Total: ${eventsAfterCheckpoint.length}`);
  console.log(`    Status: Not yet processed (expected)\n`);

  // Check for checkpoint lag
  const checkpointLag = currentBlock - checkpoint.lastProcessedBlock;

  if (checkpointLag > 100) {
    console.log(`⚠️  WARNING: Checkpoint is ${checkpointLag} blocks behind current block`);
    console.log(`    This might indicate the agent is not running or has issues.\n`);
  } else if (checkpointLag > 10) {
    console.log(`ℹ️  Checkpoint is ${checkpointLag} blocks behind (normal if agent just started)\n`);
  } else {
    console.log(`✅ Checkpoint is up to date (${checkpointLag} blocks behind)\n`);
  }

  // Show recent unprocessed events
  if (eventsAfterCheckpoint.length > 0) {
    console.log('📋 Recent unprocessed events:');
    const recent = eventsAfterCheckpoint.slice(0, 5);

    for (const event of recent) {
      console.log(`\n  Block ${event.blockNumber}:`);
      console.log(`    Request ID: ${event.args.requestId}`);
      console.log(`    Subscription ID: ${event.args.subscriptionId}`);
      console.log(`    Container: ${event.args.containerId}`);
      console.log(`    Tx: ${event.transactionHash}`);
    }

    if (eventsAfterCheckpoint.length > 5) {
      console.log(`\n  ... and ${eventsAfterCheckpoint.length - 5} more`);
    }
  }

  console.log('\n✅ Audit complete\n');

  // Recommendations
  if (checkpointLag > 100) {
    console.log('💡 Recommendations:');
    console.log('  1. Check if the agent is running');
    console.log('  2. Review agent logs for errors');
    console.log('  3. Consider restarting the agent to trigger event replay\n');
  }
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
