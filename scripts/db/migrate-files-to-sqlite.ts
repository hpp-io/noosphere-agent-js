/**
 * Migrate File-Based Storage to SQLite
 *
 * Migrates:
 * - checkpoint.json → checkpoints table
 * - agent-status.json → agent_status_log table
 */

import fs from 'fs';
import path from 'path';
import { getDatabase, Checkpoint, AgentStatusLog } from '../../lib/db';

const NOOSPHERE_DIR = path.join(process.cwd(), '.noosphere');
const CHECKPOINT_FILE = path.join(NOOSPHERE_DIR, 'checkpoint.json');
const AGENT_STATUS_FILE = path.join(NOOSPHERE_DIR, 'agent-status.json');

async function main() {
  console.log('🔄 Starting migration from files to SQLite...\n');

  const db = getDatabase();
  let migrated = 0;

  // ==================== Migrate Checkpoint ====================
  if (fs.existsSync(CHECKPOINT_FILE)) {
    try {
      console.log('📍 Migrating checkpoint.json...');
      const checkpointData = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));

      const checkpoint: Checkpoint = {
        block_number: checkpointData.lastProcessedBlock,
        block_timestamp: checkpointData.timestamp,
        checkpoint_type: 'auto',
        note: 'Migrated from checkpoint.json',
      };

      db.saveCheckpoint(checkpoint);
      console.log(`  ✓ Saved checkpoint at block ${checkpoint.block_number}`);
      migrated++;

      // Backup original file
      const backupPath = `${CHECKPOINT_FILE}.backup-${Date.now()}`;
      fs.copyFileSync(CHECKPOINT_FILE, backupPath);
      console.log(`  ✓ Backed up to ${path.basename(backupPath)}`);
    } catch (error) {
      console.error('  ❌ Failed to migrate checkpoint:', error);
    }
  } else {
    console.log('📍 checkpoint.json not found, skipping...');
  }

  // ==================== Migrate Agent Status ====================
  if (fs.existsSync(AGENT_STATUS_FILE)) {
    try {
      console.log('\n📊 Migrating agent-status.json...');
      const statusData = JSON.parse(fs.readFileSync(AGENT_STATUS_FILE, 'utf-8'));

      const status: AgentStatusLog = {
        running: statusData.running,
        address: statusData.address,
        containers_running: statusData.containers?.runningCount || 0,
        total_subscriptions: statusData.scheduler?.totalSubscriptions || 0,
        active_subscriptions: statusData.scheduler?.activeSubscriptions || 0,
        committed_intervals: statusData.scheduler?.committedIntervals || 0,
        pending_transactions: statusData.scheduler?.pendingTransactions || 0,
      };

      db.logAgentStatus(status);
      console.log(`  ✓ Logged status for agent ${status.address}`);
      migrated++;

      // Backup original file
      const backupPath = `${AGENT_STATUS_FILE}.backup-${Date.now()}`;
      fs.copyFileSync(AGENT_STATUS_FILE, backupPath);
      console.log(`  ✓ Backed up to ${path.basename(backupPath)}`);
    } catch (error) {
      console.error('  ❌ Failed to migrate agent status:', error);
    }
  } else {
    console.log('\n📊 agent-status.json not found, skipping...');
  }

  // ==================== Summary ====================
  console.log('\n' + '='.repeat(50));
  console.log(`✅ Migration complete!`);
  console.log(`   Files migrated: ${migrated}`);
  console.log(`   Database: .noosphere/agent.db`);
  console.log('='.repeat(50));

  // Verify migration
  console.log('\n📋 Verification:');
  const latestCheckpoint = db.getLatestCheckpoint();
  if (latestCheckpoint) {
    console.log(`  ✓ Latest checkpoint: Block ${latestCheckpoint.block_number}`);
  }

  const latestStatus = db.getLatestAgentStatus();
  if (latestStatus) {
    console.log(`  ✓ Latest status: Agent ${latestStatus.address}`);
  }

  console.log('\n💡 Next steps:');
  console.log('   1. Review backups in .noosphere/');
  console.log('   2. Test agent with: npm run agent');
  console.log('   3. Delete backup files when confident');
}

main().catch(console.error);
