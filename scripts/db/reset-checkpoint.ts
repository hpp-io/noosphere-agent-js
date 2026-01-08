/**
 * Reset Checkpoint Tool
 *
 * Resets the agent's checkpoint to a specific block number.
 * Useful for recovering from corrupted checkpoints or forcing event replay.
 *
 * Usage:
 *   tsx scripts/reset-checkpoint.ts --block 12000
 *   tsx scripts/reset-checkpoint.ts --deployment  (reset to deployment block)
 */

import { config as loadEnv } from 'dotenv';
import * as fs from 'fs/promises';
import * as path from 'path';

loadEnv();

interface Checkpoint {
  lastProcessedBlock: number;
  timestamp: number;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result: { block?: number; deployment?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--block' && args[i + 1]) {
      result.block = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--deployment') {
      result.deployment = true;
    }
  }

  return result;
}

async function main() {
  console.log('🔧 Checkpoint Reset Tool\n');

  const args = parseArgs();

  // Load config
  const configPath = path.join(process.cwd(), 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));

  // Determine target block
  let targetBlock: number;

  if (args.deployment) {
    targetBlock = config.chain.deploymentBlock || 0;
    console.log(`📍 Resetting to deployment block: ${targetBlock}\n`);
  } else if (args.block !== undefined) {
    targetBlock = args.block;
    console.log(`📍 Resetting to block: ${targetBlock}\n`);
  } else {
    console.error('❌ Error: Must specify --block <number> or --deployment');
    console.log('\nUsage:');
    console.log('  tsx scripts/reset-checkpoint.ts --block 12000');
    console.log('  tsx scripts/reset-checkpoint.ts --deployment');
    process.exit(1);
  }

  // Ensure .noosphere directory exists
  const checkpointDir = path.join(process.cwd(), '.noosphere');
  await fs.mkdir(checkpointDir, { recursive: true });

  const checkpointPath = path.join(checkpointDir, 'checkpoint.json');
  const backupPath = path.join(checkpointDir, 'checkpoint.bak');

  // Backup existing checkpoint
  try {
    const existing = await fs.readFile(checkpointPath, 'utf-8');
    await fs.writeFile(backupPath, existing);
    console.log('✓ Backed up existing checkpoint to checkpoint.bak');
  } catch (error) {
    console.log('ℹ️  No existing checkpoint to backup');
  }

  // Create new checkpoint
  const checkpoint: Checkpoint = {
    lastProcessedBlock: targetBlock,
    timestamp: Date.now(),
  };

  await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));

  console.log('✓ Checkpoint reset successfully\n');
  console.log('New checkpoint:');
  console.log(`  Block: ${checkpoint.lastProcessedBlock}`);
  console.log(`  Timestamp: ${new Date(checkpoint.timestamp).toISOString()}\n`);

  console.log('⚠️  Important:');
  console.log('  1. The agent will replay events from block ' + targetBlock + ' on next start');
  console.log('  2. Make sure the agent is not currently running');
  console.log('  3. Review the backup at .noosphere/checkpoint.bak if needed\n');
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
