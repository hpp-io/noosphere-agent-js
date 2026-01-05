/**
 * Noosphere Agent - Main Entry Point
 *
 * This agent uses the noosphere-sdk to:
 * 1. Listen for RequestStarted events on the blockchain
 * 2. Execute containers based on requests
 * 3. Submit results back to the coordinator
 */

import { config as loadEnv } from 'dotenv';
import { NoosphereAgent, ContainerManager } from '@noosphere/agent-core';
import { RegistryManager } from '@noosphere/registry';
import type { ContainerMetadata as RegistryContainerMetadata } from '@noosphere/registry';
import type { ContainerMetadata as AgentContainerMetadata } from '@noosphere/agent-core';
import { loadConfig } from '../lib/config';

// Load environment variables (for secrets)
loadEnv();

// Load configuration from config.json
const config = loadConfig();

// Agent configuration
const AGENT_CONFIG = {
  keystorePath: config.chain.wallet.keystorePath,
  password: config.secrets.keystorePassword,
  rpcUrl: config.chain.rpcUrl,
  wsRpcUrl: config.chain.wsRpcUrl || undefined,
  routerAddress: config.chain.routerAddress,
  coordinatorAddress: config.chain.coordinatorAddress,
  deploymentBlock: config.chain.deploymentBlock,
};

// Router ABI - minimal required events and functions
const ROUTER_ABI = [
  'event RequestStarted(bytes32 indexed requestId, uint256 indexed subscriptionId, bytes32 containerId, uint256 interval, uint8 redundancy, bool useDeliveryInbox, uint256 feeAmount, address feeToken, address verifier, address coordinator)',
];

// Coordinator ABI - minimal required functions and events
const COORDINATOR_ABI = [
  'event RequestStarted(bytes32 indexed requestId, uint256 indexed subscriptionId, bytes32 containerId, uint256 interval, uint8 redundancy, bool useDeliveryInbox, uint256 feeAmount, address feeToken, address verifier, address coordinator)',
  'function redundancyCount(bytes32 requestId) view returns (uint8)',
  'function fulfill(bytes32 requestId, bytes memory result, bytes memory proof) external returns (uint8)',
];

/**
 * Adapter function to convert registry ContainerMetadata to agent-core ContainerMetadata
 */
function adaptContainerMetadata(
  registryMeta: RegistryContainerMetadata | null | undefined
): AgentContainerMetadata | undefined {
  if (!registryMeta) return undefined;

  return {
    id: registryMeta.id,
    name: registryMeta.name,
    image: registryMeta.imageName, // Map imageName to image
    tag: 'latest', // Default tag, could be extracted from imageName if needed
    requirements: registryMeta.requirements,
    payments: registryMeta.payments
      ? {
          basePrice: registryMeta.payments.basePrice,
          unit: registryMeta.payments.token, // Map token to unit
          per: registryMeta.payments.per,
        }
      : undefined,
    verified: registryMeta.verified,
  };
}

/**
 * Convert config containers array to Map for ContainerManager
 */
function buildContainerMap(
  containers: Array<{
    id: string;
    image: string;
    port: string;
    env?: Record<string, string>;
  }>
): Map<string, AgentContainerMetadata> {
  const containerMap = new Map<string, AgentContainerMetadata>();

  for (const container of containers) {
    // Split image and tag if present
    const [image, tag] = container.image.includes(':')
      ? container.image.split(':')
      : [container.image, 'latest'];

    containerMap.set(container.id, {
      id: container.id,
      name: container.id,
      image,
      tag,
      port: container.port,
      env: container.env,
    });
  }

  return containerMap;
}

/**
 * Convert config verifiers with proof services to container Map
 */
function buildVerifierProofServiceMap(
  verifiers: Array<{
    id: string;
    name: string;
    address: string;
    requiresProof?: boolean;
    proofService?: {
      image: string;
      port: string;
      command?: string;
      env?: Record<string, string>;
      requirements?: {
        gpu?: boolean;
        memory?: string;
        cpu?: number;
      };
    };
  }>
): Map<string, AgentContainerMetadata> {
  const containerMap = new Map<string, AgentContainerMetadata>();

  for (const verifier of verifiers) {
    // Only add proof services that exist and are required
    if (verifier.requiresProof && verifier.proofService) {
      const proofService = verifier.proofService;
      const containerId = `proof-service-${verifier.id}`;

      // Split image and tag if present
      const [image, tag] = proofService.image.includes(':')
        ? proofService.image.split(':')
        : [proofService.image, 'latest'];

      containerMap.set(containerId, {
        id: containerId,
        name: `Proof Service: ${verifier.name}`,
        image,
        tag,
        port: proofService.port,
        env: proofService.env,
        command: proofService.command,
      });
    }
  }

  return containerMap;
}

async function main() {
  console.log('🚀 Starting Noosphere Agent...\n');

  // Validate configuration (already validated in loadConfig, but double-check critical values)
  if (!AGENT_CONFIG.password) {
    throw new Error('KEYSTORE_PASSWORD is required (set in .env file)');
  }
  if (!AGENT_CONFIG.rpcUrl) {
    throw new Error('rpcUrl is required (set in config.json)');
  }
  if (!AGENT_CONFIG.routerAddress) {
    throw new Error('routerAddress is required (set in config.json)');
  }
  if (!AGENT_CONFIG.coordinatorAddress) {
    throw new Error('coordinatorAddress is required (set in config.json)');
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

  // Initialize ContainerManager and prepare containers from config
  console.log('🐳 Preparing containers from config...');
  const containerManager = new ContainerManager();

  // Check if Docker is available
  const dockerAvailable = await containerManager.checkDockerAvailable();
  if (!dockerAvailable) {
    console.warn('⚠️  Docker is not available. Containers will not be started.');
    console.warn('   Agent will still run but cannot execute container requests.\n');
  } else {
    // Build container map from config
    const containerMap = buildContainerMap(config.containers);
    console.log(`  Found ${containerMap.size} containers in config`);

    // Prepare containers (pull images and start persistent containers)
    await containerManager.prepareContainers(containerMap);

    // Prepare verifier proof service containers if configured
    if (config.verifiers && config.verifiers.length > 0) {
      console.log('\n🔐 Preparing verifier proof services...');
      const proofServiceMap = buildVerifierProofServiceMap(config.verifiers);

      if (proofServiceMap.size > 0) {
        console.log(`  Found ${proofServiceMap.size} proof services in config`);
        await containerManager.prepareContainers(proofServiceMap);
      } else {
        console.log('  No proof services require containers');
      }
    }
  }

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
      getContainer: (containerId: string) => adaptContainerMetadata(registry.getContainer(containerId)),
    }
  );

  console.log('✓ Agent initialized from keystore\n');

  // Start the agent
  await agent.start();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\n⚠️  Received SIGINT, shutting down gracefully...');
    await agent.stop();
    await containerManager.stopPersistentContainers();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\n⚠️  Received SIGTERM, shutting down gracefully...');
    await agent.stop();
    await containerManager.stopPersistentContainers();
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
