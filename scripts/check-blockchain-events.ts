#!/usr/bin/env tsx

/**
 * Check Blockchain Events
 *
 * This script queries the blockchain for SubscriptionFulfilled events
 * to verify that the history API can retrieve data from the blockchain.
 */

import { config } from 'dotenv';
import { JsonRpcProvider, Contract } from 'ethers';

config();

const COORDINATOR_ABI = [
  'event SubscriptionFulfilled(uint32 indexed id, address indexed node)',
  'function getSubscription(uint32 subscriptionId) view returns (tuple(address owner, uint32 activeAt, uint32 period, uint32 frequency, uint16 redundancy, bytes32 containerId, bool lazy, address verifier, uint256 paymentAmount, address paymentToken, address wallet))',
];

async function checkEvents() {
  console.log('🔍 Checking Blockchain Events\n');

  const rpcUrl = process.env.RPC_URL;
  const coordinatorAddress = process.env.COORDINATOR_ADDRESS;
  const deploymentBlock = parseInt(process.env.DEPLOYMENT_BLOCK || '0');

  if (!rpcUrl || !coordinatorAddress) {
    console.error('❌ Missing RPC_URL or COORDINATOR_ADDRESS in .env');
    process.exit(1);
  }

  console.log(`RPC URL: ${rpcUrl}`);
  console.log(`Coordinator: ${coordinatorAddress}`);
  console.log(`Deployment Block: ${deploymentBlock}\n`);

  try {
    const provider = new JsonRpcProvider(rpcUrl);
    const coordinator = new Contract(coordinatorAddress, COORDINATOR_ABI, provider);

    // Get current block
    const currentBlock = await provider.getBlockNumber();
    console.log(`Current Block: ${currentBlock}`);
    console.log(`Scanning from block ${deploymentBlock} to ${currentBlock}...\n`);

    // Query all SubscriptionFulfilled events (no filter)
    console.log('1️⃣  Querying ALL SubscriptionFulfilled events...');
    const allEventsFilter = coordinator.filters.SubscriptionFulfilled();
    const allEvents = await coordinator.queryFilter(allEventsFilter, deploymentBlock);

    console.log(`   Found ${allEvents.length} total events\n`);

    if (allEvents.length > 0) {
      console.log('📊 Recent Events (last 5):\n');
      const recentEvents = allEvents.slice(-5);

      for (const event of recentEvents) {
        const subscriptionId = Number(event.args![0]);
        const nodeAddress = event.args![1];
        const block = await event.getBlock();

        console.log(`   Subscription #${subscriptionId}`);
        console.log(`   Node: ${nodeAddress}`);
        console.log(`   Block: ${event.blockNumber}`);
        console.log(`   Time: ${new Date(block.timestamp * 1000).toLocaleString()}`);
        console.log(`   Tx: ${event.transactionHash}`);
        console.log('   ---');
      }

      // Check if our agent has any events
      const keystorePath = process.env.KEYSTORE_PATH || './.noosphere/keystore.json';
      const password = process.env.KEYSTORE_PASSWORD;

      if (password) {
        const { KeystoreManager } = await import('@noosphere/crypto');
        const fs = await import('fs/promises');

        const keystoreData = await fs.readFile(keystorePath, 'utf-8');
        const keystore = await KeystoreManager.importKeystore(keystorePath, password, keystoreData);
        const agentAddress = keystore.getEOAAddress();

        console.log(`\n2️⃣  Checking events for agent: ${agentAddress}...\n`);

        const agentEventsFilter = coordinator.filters.SubscriptionFulfilled(null, agentAddress);
        const agentEvents = await coordinator.queryFilter(agentEventsFilter, deploymentBlock);

        console.log(`   Found ${agentEvents.length} events for this agent`);

        if (agentEvents.length > 0) {
          console.log('\n   ✅ This agent has processing history!');
          for (const event of agentEvents) {
            const subscriptionId = Number(event.args![0]);
            console.log(`      - Subscription #${subscriptionId} at block ${event.blockNumber}`);
          }
        } else {
          console.log('\n   ℹ️  This agent hasn\'t processed any requests yet.');
          console.log('      To test the history feature:');
          console.log('      1. Make sure the agent is running (npm run agent)');
          console.log('      2. Submit a request to the coordinator contract');
          console.log('      3. Wait for the agent to process it');
          console.log('      4. Check the history API or run this script again');
        }
      }
    } else {
      console.log('ℹ️  No events found on this blockchain.');
      console.log('   This could mean:');
      console.log('   - No requests have been processed yet');
      console.log('   - The deployment block is incorrect');
      console.log('   - The coordinator address is incorrect');
    }

    console.log('\n✅ Event check complete');
  } catch (error) {
    console.error('\n❌ Error checking events:', error);
    if (error instanceof Error) {
      console.error(`   ${error.message}`);
    }
    process.exit(1);
  }
}

checkEvents();
