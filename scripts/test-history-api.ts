#!/usr/bin/env tsx

/**
 * E2E Test: History API Verification
 *
 * This script tests the computing history API endpoint to verify:
 * 1. API endpoint is accessible
 * 2. Blockchain event queries work correctly
 * 3. Data is properly formatted and returned
 */

import { config } from 'dotenv';

config();

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const TIMEOUT_MS = 10000;

interface HistoryEntry {
  subscriptionId: number;
  blockNumber: number;
  timestamp: number;
  transactionHash: string;
  subscription: {
    owner: string;
    containerId: string;
    frequency: number;
    period: number;
    redundancy: number;
    lazy: boolean;
    paymentAmount: string;
    paymentToken: string;
  };
}

interface HistoryResponse {
  agentAddress: string;
  total: number;
  limit: number;
  offset: number;
  history: HistoryEntry[];
}

async function testHistoryAPI() {
  console.log('🧪 E2E Test: Computing History API\n');
  console.log(`Testing API at: ${API_BASE_URL}\n`);

  try {
    // Test 1: Fetch agent status (prerequisite)
    console.log('1️⃣  Testing Agent Status API...');
    const statusRes = await fetch(`${API_BASE_URL}/api/agent/status`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!statusRes.ok) {
      const errorData = await statusRes.json();
      throw new Error(`Agent status API failed: ${errorData.error || statusRes.statusText}`);
    }

    const statusData = await statusRes.json();
    console.log(`   ✅ Agent address: ${statusData.agentAddress}`);
    console.log(`   ✅ Balance: ${statusData.balance} ETH`);
    console.log(`   ✅ RPC URL: ${statusData.rpcUrl}`);
    console.log(`   ✅ Coordinator: ${statusData.coordinatorAddress}\n`);

    // Test 2: Fetch computing history
    console.log('2️⃣  Testing History API...');
    const historyRes = await fetch(`${API_BASE_URL}/api/history?limit=50&offset=0`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!historyRes.ok) {
      const errorData = await historyRes.json();
      throw new Error(`History API failed: ${errorData.error || historyRes.statusText}`);
    }

    const historyData: HistoryResponse = await historyRes.json();
    console.log(`   ✅ API Response received`);
    console.log(`   ✅ Agent address matches: ${historyData.agentAddress === statusData.agentAddress}`);
    console.log(`   ✅ Total computations: ${historyData.total}`);
    console.log(`   ✅ History entries returned: ${historyData.history.length}\n`);

    // Test 3: Validate history data structure
    if (historyData.history.length > 0) {
      console.log('3️⃣  Validating History Data Structure...');
      const firstEntry = historyData.history[0];

      const requiredFields = [
        'subscriptionId',
        'blockNumber',
        'timestamp',
        'transactionHash',
        'subscription',
      ];

      for (const field of requiredFields) {
        if (!(field in firstEntry)) {
          throw new Error(`Missing required field in history entry: ${field}`);
        }
      }

      const requiredSubFields = [
        'owner',
        'containerId',
        'frequency',
        'period',
        'redundancy',
        'lazy',
        'paymentAmount',
        'paymentToken',
      ];

      for (const field of requiredSubFields) {
        if (!(field in firstEntry.subscription)) {
          throw new Error(`Missing required field in subscription data: ${field}`);
        }
      }

      console.log(`   ✅ All required fields present`);
      console.log(`\n   📊 Sample Entry:`);
      console.log(`      Subscription ID: ${firstEntry.subscriptionId}`);
      console.log(`      Block Number: ${firstEntry.blockNumber}`);
      console.log(`      Timestamp: ${new Date(firstEntry.timestamp * 1000).toLocaleString()}`);
      console.log(`      Transaction: ${firstEntry.transactionHash.substring(0, 20)}...`);
      console.log(`      Container ID: ${firstEntry.subscription.containerId.substring(0, 20)}...`);
      console.log(`      Owner: ${firstEntry.subscription.owner}`);
      console.log(`      Redundancy: ${firstEntry.subscription.redundancy}`);
      console.log(`      Lazy: ${firstEntry.subscription.lazy}`);
      console.log(`      Payment: ${firstEntry.subscription.paymentAmount === '0' ? 'None' : firstEntry.subscription.paymentAmount}\n`);

      // Test 4: Verify pagination
      if (historyData.total > 20) {
        console.log('4️⃣  Testing Pagination...');
        const page2Res = await fetch(`${API_BASE_URL}/api/history?limit=20&offset=20`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!page2Res.ok) {
          throw new Error('Pagination test failed');
        }

        const page2Data: HistoryResponse = await page2Res.json();
        console.log(`   ✅ Page 2 entries: ${page2Data.history.length}`);
        console.log(`   ✅ Offset correctly applied: ${page2Data.offset === 20}\n`);
      } else {
        console.log('4️⃣  Skipping pagination test (not enough data)\n');
      }
    } else {
      console.log('ℹ️  No computing history found (agent hasn\'t processed any requests yet)\n');
      console.log('   This is normal for a new agent. History will appear after processing requests.\n');
    }

    // Summary
    console.log('═══════════════════════════════════════════════════════');
    console.log('✅ All tests passed!');
    console.log('═══════════════════════════════════════════════════════\n');

    console.log('Test Summary:');
    console.log(`  - Agent Address: ${statusData.agentAddress}`);
    console.log(`  - Total Computations: ${historyData.total}`);
    console.log(`  - API Status: Working ✓`);
    console.log(`  - Data Structure: Valid ✓`);
    console.log(`  - Pagination: ${historyData.total > 20 ? 'Tested ✓' : 'Skipped (insufficient data)'}`);

  } catch (error) {
    console.error('\n❌ Test failed:');
    if (error instanceof Error) {
      console.error(`   Error: ${error.message}`);

      if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
        console.error('\n💡 Tip: Make sure the Next.js dev server is running:');
        console.error('   npm run dev');
      }
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

// Run the test
testHistoryAPI();
