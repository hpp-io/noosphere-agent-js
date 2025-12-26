/**
 * Noosphere Agent - Main Entry Point
 *
 * This agent uses the noosphere-sdk to:
 * 1. Listen for RequestStarted events on the blockchain
 * 2. Execute containers based on requests
 * 3. Submit results back to the coordinator
 */

import { config } from 'dotenv';
import { NoosphereAgent } from '@noosphere/agent-core';
import { RegistryManager } from '@noosphere/registry';

// Load environment variables
config();

// Agent configuration
const AGENT_CONFIG = {
  keystorePath: process.env.KEYSTORE_PATH || './.noosphere/keystore.json',
  password: process.env.KEYSTORE_PASSWORD!,
  rpcUrl: process.env.RPC_URL!,
  wsRpcUrl: process.env.WS_RPC_URL,
  routerAddress: process.env.ROUTER_ADDRESS!,
  coordinatorAddress: process.env.COORDINATOR_ADDRESS!,
  deploymentBlock: parseInt(process.env.DEPLOYMENT_BLOCK || '0'),
};

// Router ABI - minimal required events and functions
const ROUTER_ABI = [
  'event RequestStarted(bytes32 indexed requestId, uint256 indexed subscriptionId, bytes32 containerId, uint256 interval, uint8 redundancy, bool useDeliveryInbox, uint256 feeAmount, address feeToken, address verifier, address coordinator)',
];

// Coordinator ABI - minimal required functions
const COORDINATOR_ABI = [
  'function redundancyCount(bytes32 requestId) view returns (uint8)',
  'function fulfill(bytes32 requestId, bytes memory result, bytes memory proof) external returns (uint8)',
];

async function main() {
  console.log('🚀 Starting Noosphere Agent...\n');

  // Validate environment variables
  if (!AGENT_CONFIG.password) {
    throw new Error('KEYSTORE_PASSWORD environment variable is required');
  }
  if (!AGENT_CONFIG.rpcUrl) {
    throw new Error('RPC_URL environment variable is required');
  }
  if (!AGENT_CONFIG.routerAddress) {
    throw new Error('ROUTER_ADDRESS environment variable is required');
  }
  if (!AGENT_CONFIG.coordinatorAddress) {
    throw new Error('COORDINATOR_ADDRESS environment variable is required');
  }

  console.log('Configuration:');
  console.log(`  Keystore: ${AGENT_CONFIG.keystorePath}`);
  console.log(`  RPC URL: ${AGENT_CONFIG.rpcUrl}`);
  console.log(`  WS RPC URL: ${AGENT_CONFIG.wsRpcUrl || 'Not configured'}`);
  console.log(`  Router: ${AGENT_CONFIG.routerAddress}`);
  console.log(`  Coordinator: ${AGENT_CONFIG.coordinatorAddress}`);
  console.log(`  Deployment Block: ${AGENT_CONFIG.deploymentBlock}\n`);

  // Load container registry
  console.log('📦 Loading container registry...');
  const registry = new RegistryManager({
    autoSync: true,
    cacheTTL: 3600000, // 1 hour
  });
  await registry.load();

  const stats = registry.getStats();
  console.log(`✓ Registry loaded:`);
  console.log(`  Containers: ${stats.totalContainers} (${stats.activeContainers} active)`);
  console.log(`  Verifiers: ${stats.totalVerifiers} (${stats.activeVerifiers} active)\n`);

  // Initialize agent from keystore
  console.log('🔐 Loading agent from keystore...');
  const agent = await NoosphereAgent.fromKeystore(
    AGENT_CONFIG.keystorePath,
    AGENT_CONFIG.password,
    {
      config: {
        rpcUrl: AGENT_CONFIG.rpcUrl,
        wsRpcUrl: AGENT_CONFIG.wsRpcUrl,
        routerAddress: AGENT_CONFIG.routerAddress,
        coordinatorAddress: AGENT_CONFIG.coordinatorAddress,
        deploymentBlock: AGENT_CONFIG.deploymentBlock,
      },
      routerAbi: ROUTER_ABI,
      coordinatorAbi: COORDINATOR_ABI,
      getContainer: (containerId: string) => registry.getContainer(containerId),
    }
  );

  console.log('✓ Agent initialized from keystore\n');

  // Start the agent
  await agent.start();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\n⚠️  Received SIGINT, shutting down gracefully...');
    await agent.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\n⚠️  Received SIGTERM, shutting down gracefully...');
    await agent.stop();
    process.exit(0);
  });

  // Keep process alive
  console.log('✅ Agent is running. Press Ctrl+C to stop.\n');
}

// Run the agent
main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
