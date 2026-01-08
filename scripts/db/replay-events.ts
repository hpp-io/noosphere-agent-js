/**
 * Manual Event Replay Tool
 *
 * Replays RequestStarted events from a specific block range.
 * Useful for recovering from missed events or investigating issues.
 *
 * Usage:
 *   tsx scripts/replay-events.ts --from 12000 --to 13000
 *   tsx scripts/replay-events.ts --from 12000  (to latest)
 *   tsx scripts/replay-events.ts --last 100    (last 100 blocks)
 */

import { config as loadEnv } from 'dotenv';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

loadEnv();

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const result: { from?: number; to?: number | string; last?: number } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) {
      result.from = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--to' && args[i + 1]) {
      result.to = args[i + 1] === 'latest' ? 'latest' : parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--last' && args[i + 1]) {
      result.last = parseInt(args[i + 1]);
      i++;
    }
  }

  return result;
}

async function main() {
  console.log('🔄 Manual Event Replay Tool\n');

  const args = parseArgs();

  // Load config
  const configPath = path.join(process.cwd(), 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ config.json not found');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Load ABIs
  const routerAbiPath = process.env.ROUTER_ABI_PATH ||
    path.join(process.cwd(), '../noosphere-evm/out/Router.sol/Router.abi.json');
  const coordinatorAbiPath = process.env.COORDINATOR_ABI_PATH ||
    path.join(process.cwd(), '../noosphere-evm/out/Coordinator.sol/Coordinator.abi.json');

  const routerAbi = JSON.parse(fs.readFileSync(routerAbiPath, 'utf-8'));
  const coordinatorAbi = JSON.parse(fs.readFileSync(coordinatorAbiPath, 'utf-8'));

  // Setup provider
  const provider = new ethers.JsonRpcProvider(config.chain.rpcUrl);
  const coordinator = new ethers.Contract(
    config.chain.coordinatorAddress,
    coordinatorAbi,
    provider
  );

  // Determine block range
  let fromBlock: number;
  let toBlock: number | string;

  if (args.last) {
    // Last N blocks
    const currentBlock = await provider.getBlockNumber();
    fromBlock = currentBlock - args.last;
    toBlock = currentBlock;
    console.log(`📊 Replaying last ${args.last} blocks (${fromBlock} to ${toBlock})\n`);
  } else {
    // From/To range
    fromBlock = args.from || config.chain.deploymentBlock || 0;
    toBlock = args.to || 'latest';

    if (toBlock === 'latest') {
      const currentBlock = await provider.getBlockNumber();
      console.log(`📊 Replaying from block ${fromBlock} to ${currentBlock} (latest)\n`);
    } else {
      console.log(`📊 Replaying from block ${fromBlock} to ${toBlock}\n`);
    }
  }

  // Replay events in chunks
  const currentBlock = await provider.getBlockNumber();
  const toBlockNumber = toBlock === 'latest' ? currentBlock : Number(toBlock);
  const chunkSize = 10000;

  let totalEvents = 0;

  for (let start = fromBlock; start <= toBlockNumber; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlockNumber);

    console.log(`🔍 Querying blocks ${start} to ${end}...`);

    const events = await coordinator.queryFilter(
      coordinator.filters.RequestStarted(),
      start,
      end
    );

    if (events.length > 0) {
      console.log(`  ✓ Found ${events.length} events`);

      for (const event of events) {
        const eventLog = event as any;
        const commitment = eventLog.args.commitment;

        console.log(`\n  📨 RequestStarted:`);
        console.log(`    Request ID: ${eventLog.args.requestId}`);
        console.log(`    Subscription ID: ${eventLog.args.subscriptionId}`);
        console.log(`    Container ID: ${eventLog.args.containerId}`);
        console.log(`    Interval: ${commitment.interval}`);
        console.log(`    Redundancy: ${commitment.redundancy}`);
        console.log(`    Block: ${event.blockNumber}`);
        console.log(`    Tx: ${event.transactionHash}`);

        totalEvents++;
      }
    } else {
      console.log(`  No events found`);
    }
  }

  console.log(`\n✅ Replay complete: ${totalEvents} events found\n`);

  // Ask if user wants to update checkpoint
  if (totalEvents > 0) {
    console.log('💡 Tip: To prevent re-processing these events, you can update the checkpoint:');
    console.log(`   tsx scripts/reset-checkpoint.ts --block ${toBlockNumber}`);
  }
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
