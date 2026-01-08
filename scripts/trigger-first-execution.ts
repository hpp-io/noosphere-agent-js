/**
 * Trigger First Execution
 *
 * Manually trigger the first execution of a scheduled subscription
 *
 * Usage:
 *   npm run trigger:first -- <subscriptionId>
 */

import { config as loadEnv } from 'dotenv';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

loadEnv();

const SCHEDULED_CLIENT_ABI = [
  "function triggerFirstExecution(uint64 subscriptionId, bytes memory inputs) external returns (uint64, tuple(bytes32 requestKey, address client, uint64 subscriptionId, uint32 interval, bytes inputs, uint256 timestamp, uint256 blockNumber, address wallet, address verifier, bytes32 routeId) memory)"
];

async function main() {
  console.log('🚀 Triggering First Execution for Scheduled Subscription\n');

  const configPath = path.join(process.cwd(), 'config.json');
  const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY environment variable is required');
  }

  const provider = new ethers.JsonRpcProvider(configData.chain.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const SCHEDULED_CLIENT_ADDRESS = process.env.SCHEDULED_CLIENT_ADDRESS || '0x9e2A66606e5dF1B72830e6390AD6625CC46669aC';
  const subscriptionId = process.argv[2] ? parseInt(process.argv[2]) : 5;

  console.log(`📋 Triggering subscription ${subscriptionId}...`);
  console.log(`  Client: ${SCHEDULED_CLIENT_ADDRESS}\n`);

  const client = new ethers.Contract(SCHEDULED_CLIENT_ADDRESS, SCHEDULED_CLIENT_ABI, wallet);

  const tx = await client.triggerFirstExecution(
    subscriptionId,
    ethers.toUtf8Bytes(''), // Empty inputs for hello-world
    { gasLimit: 500000 }
  );

  const receipt = await tx.wait();
  console.log(`  ✓ Transaction: ${receipt.hash}\n`);

  console.log('✅ First execution triggered!');
  console.log('   Agent should now detect and process the subscription.\n');
  console.log('🔍 Monitor at:');
  console.log(`   - Dashboard: http://localhost:3000`);
  console.log(`   - History: http://localhost:3000/history`);
  console.log(`   - Explorer: https://explorer.hpp.io/tx/${receipt.hash}\n`);
}

main().catch((error) => {
  console.error('\n❌ Error:', error.message);
  if (error.stack) {
    console.error('\nStack trace:');
    console.error(error.stack);
  }
  process.exit(1);
});
