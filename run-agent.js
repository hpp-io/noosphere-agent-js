/**
 * Run Noosphere Agent from config.json
 */

require('dotenv').config();
const { NoosphereAgent, ContainerManager } = require('@noosphere/agent-core');
const { RegistryManager } = require('@noosphere/registry');
const fs = require('fs');
const path = require('path');

// Load ABIs
const routerAbiPath = '/Users/nol/work/noosphere/noosphere-evm/out/Router.sol/Router.abi.json';
const coordinatorAbiPath = '/Users/nol/work/noosphere/noosphere-evm/out/Coordinator.sol/Coordinator.abi.json';

async function main() {
  try {
    console.log('🚀 Starting Noosphere Agent from config.json...\n');

    // Load ABIs
    console.log('📋 Loading contract ABIs...');
    const routerAbi = JSON.parse(fs.readFileSync(routerAbiPath, 'utf-8'));
    const coordinatorAbi = JSON.parse(fs.readFileSync(coordinatorAbiPath, 'utf-8'));
    console.log('✓ ABIs loaded\n');

    // Load configuration
    const configPath = path.join(__dirname, 'config.json');
    console.log(`📄 Loading config from: ${configPath}\n`);
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Get password from environment
    const password = process.env.KEYSTORE_PASSWORD;
    if (!password) {
      throw new Error('KEYSTORE_PASSWORD environment variable is required');
    }

    console.log('Configuration:');
    console.log(`  Keystore: ${configData.chain.wallet.keystorePath}`);
    console.log(`  RPC URL: ${configData.chain.rpcUrl}`);
    console.log(`  Router: ${configData.chain.routerAddress}`);
    console.log(`  Coordinator: ${configData.chain.coordinatorAddress}`);
    console.log(`  Deployment Block: ${configData.chain.deploymentBlock}\n`);

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

    // Build container map from config.json
    const containerMap = new Map();
    if (configData.containers && Array.isArray(configData.containers)) {
      for (const container of configData.containers) {
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
      console.log(`📦 Loaded ${containerMap.size} containers from config.json\n`);
    }

    // Add verifier proof service containers to containerMap
    if (configData.verifiers && Array.isArray(configData.verifiers)) {
      console.log('🔐 Loading verifier proof services from config.json...');
      let proofServiceCount = 0;

      for (const verifier of configData.verifiers) {
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
          proofServiceCount++;
        }
      }

      if (proofServiceCount > 0) {
        console.log(`🔐 Loaded ${proofServiceCount} proof service containers\n`);
      }
    }

    // Create ContainerManager for cleanup on shutdown
    const containerManager = new ContainerManager();

    // Initialize agent from keystore
    console.log('🔐 Loading agent from keystore...');
    const agent = await NoosphereAgent.fromKeystore(
      configData.chain.wallet.keystorePath,
      password,
      {
        config: {
          rpcUrl: configData.chain.rpcUrl,
          wsRpcUrl: configData.chain.wsRpcUrl || undefined,
          routerAddress: configData.chain.routerAddress,
          coordinatorAddress: configData.chain.coordinatorAddress,
          deploymentBlock: configData.chain.deploymentBlock,
        },
        routerAbi,
        coordinatorAbi,
        containers: containerMap,
        paymentWallet: configData.chain.wallet.paymentAddress,
        getContainer: (containerId) => {
          const container = registry.getContainer(containerId);
          if (!container) return undefined;
          return {
            id: container.id,
            name: container.name,
            image: container.imageName,
            tag: 'latest',
            requirements: container.requirements,
            payments: container.payments ? {
              basePrice: container.payments.basePrice,
              unit: container.payments.token,
              per: container.payments.per,
            } : undefined,
            verified: container.verified,
          };
        },
      }
    );

    console.log('✓ Agent initialized from keystore\n');

    console.log('🎯 Starting agent...\n');

    // Start the agent
    await agent.start();

    // Log status every 30 seconds
    const statusInterval = setInterval(() => {
      const status = agent.getStatus();
      console.log('\n📊 Agent Status:');
      console.log(`  Running: ${status.running}`);
      console.log(`  Address: ${status.address}`);
      console.log(`  Containers: ${status.containers.runningCount} running`);
      console.log(`  Scheduler:`);
      console.log(`    - Total Subscriptions: ${status.scheduler.totalSubscriptions}`);
      console.log(`    - Active Subscriptions: ${status.scheduler.activeSubscriptions}`);
      console.log(`    - Committed Intervals: ${status.scheduler.committedIntervals}`);
      console.log(`    - Pending Transactions: ${status.scheduler.pendingTransactions}`);
    }, 30000);

    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log('\n\n🛑 Shutting down agent...\n');
      clearInterval(statusInterval);
      await agent.stop();
      console.log('🐳 Stopping Docker containers...');
      await containerManager.stopPersistentContainers();
      console.log('\n✓ Agent stopped successfully');
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n\n🛑 Shutting down agent...\n');
      clearInterval(statusInterval);
      await agent.stop();
      console.log('🐳 Stopping Docker containers...');
      await containerManager.stopPersistentContainers();
      console.log('\n✓ Agent stopped successfully');
      process.exit(0);
    });

    // Keep process alive
    console.log('\n💡 Agent is running. Press Ctrl+C to stop.\n');

  } catch (error) {
    console.error('\n❌ Error starting agent:', error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
