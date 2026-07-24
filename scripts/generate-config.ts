#!/usr/bin/env tsx
/**
 * CLI tool to generate config.json from registry
 *
 * Usage:
 *   npm run generate:config                    # Interactive mode (testnet default)
 *   npm run generate:config -- --network mainnet  # Mainnet config
 *   npm run generate:config -- --list          # List available containers
 *   npm run generate:config -- --all           # Add all containers
 *   npm run generate:config -- --containers noosphere-hello-world,noosphere-llm
 *   npm run generate:config -- --all --seller  # + x402 seller block (sell per-call)
 *   npm run generate:config -- --all --seller --seller-price 5000
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

interface NetworkPreset {
  chainId: number;
  rpcUrl: string;
  wsRpcUrl: string;
  routerAddress: string;
  coordinatorAddress: string;
  deploymentBlock: number;
  verifierAddress: string;
  proofServiceImage: string;
  vrfAddress: string;
  registryUrl: string;
  // x402 seller preset (design 04): CAIP-2 id, public facilitator, USDC.e.
  caip2: string;
  facilitatorUrl: string;
  usdceAddress: string;
}

const NETWORK_PRESETS: Record<string, NetworkPreset> = {
  testnet: {
    chainId: 181228,
    rpcUrl: 'https://sepolia.hpp.io',
    wsRpcUrl: 'wss://sepolia.hpp.io',
    routerAddress: '0x480a4f7506548773040d47dd7b6372dbf71358d4',
    coordinatorAddress: '0xeda4a7957e8f5de6cd6bd747c3ccd5e1c295302c',
    deploymentBlock: 10520,
    verifierAddress: '0x672c325941E3190838523052ebFF122146864EAd',
    proofServiceImage: 'ghcr.io/hpp-io/noosphere-proof-creator:dev',
    vrfAddress: '0xb49Cf5e93A225638cD7fa8e4479149f453AE2e39',
    registryUrl: 'https://raw.githubusercontent.com/hpp-io/noosphere-registry/main/networks/181228.json',
    caip2: 'eip155:181228',
    facilitatorUrl: 'https://facilitator-sepolia.hpp.io',
    usdceAddress: '0x401eCb1D350407f13ba348573E5630B83638E30D',
  },
  mainnet: {
    chainId: 190415,
    rpcUrl: 'https://mainnet.hpp.io',
    wsRpcUrl: 'wss://mainnet.hpp.io',
    routerAddress: '0x043F992d67dE8c86141EA5e0897b5244cD97dac4',
    coordinatorAddress: '0x8b4951d0C2B15Ef4DE1f355e132A40Ac6c84E728',
    deploymentBlock: 185172,
    verifierAddress: '0xFF46177E5210A8dc31E98477295d6A91510d67a0',
    proofServiceImage: 'ghcr.io/hpp-io/noosphere-proof-creator:latest',
    vrfAddress: '0xFd3Fc50bC7b798eDFfCFaB948A1Fd1d614fDA24c',
    registryUrl: 'https://raw.githubusercontent.com/hpp-io/noosphere-registry/main/networks/190415.json',
    caip2: 'eip155:190415',
    facilitatorUrl: 'https://facilitator.hpp.io',
    usdceAddress: '0x401eCb1D350407f13ba348573E5630B83638E30D', // same USDC.e on both HPP chains
  },
};

const CONFIG_OUTPUT_PATH = './config.json';

interface RegistryContainer {
  id: string;
  name: string;
  imageName: string;
  description?: string;
  port?: number;
  requirements?: {
    cpu?: number;
    memory?: string;
    gpu?: boolean;
  };
  env?: Record<string, string>;
  statusCode?: string;
}

interface RegistryVerifier {
  id: string;
  name: string;
  verifierAddress: string;
  description?: string;
  statusCode?: string;
}

interface Registry {
  containers: Record<string, RegistryContainer>;
  verifiers: Record<string, RegistryVerifier>;
  version: string;
}

async function fetchRegistry(registryUrl: string): Promise<Registry> {
  console.log('📡 Fetching registry from', registryUrl);
  const response = await fetch(registryUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch registry: ${response.status}`);
  }
  return response.json() as Promise<Registry>;
}

function listContainers(registry: Registry): void {
  console.log('\n📦 Available Containers:\n');

  const containers = Object.entries(registry.containers);
  if (containers.length === 0) {
    console.log('  No containers found in registry');
    return;
  }

  for (const [hashId, container] of containers) {
    const status = container.statusCode === 'ACTIVE' ? '✓' : '✗';
    console.log(`  ${status} ${container.name}`);
    console.log(`    ID: ${hashId}`);
    console.log(`    Image: ${container.imageName}`);
    if (container.port) console.log(`    Port: ${container.port}`);
    if (container.description) console.log(`    Description: ${container.description}`);
    console.log();
  }

  console.log('\n🔐 Available Verifiers:\n');

  const verifiers = Object.entries(registry.verifiers);
  if (verifiers.length === 0) {
    console.log('  No verifiers found in registry');
    return;
  }

  for (const [address, verifier] of verifiers) {
    const status = verifier.statusCode === 'ACTIVE' ? '✓' : '✗';
    console.log(`  ${status} ${verifier.name}`);
    console.log(`    Address: ${address}`);
    if (verifier.description) console.log(`    Description: ${verifier.description}`);
    console.log();
  }
}

function findContainerByName(registry: Registry, name: string): [string, RegistryContainer] | undefined {
  for (const [hashId, container] of Object.entries(registry.containers)) {
    if (container.name === name || container.name.toLowerCase() === name.toLowerCase()) {
      return [hashId, container];
    }
  }
  return undefined;
}

interface ConfigContainer {
  id: string;
  name: string;
  image: string;
  port: string;
  env?: Record<string, string>;
}

function generateContainerConfig(hashId: string, container: RegistryContainer): ConfigContainer {
  const config: ConfigContainer = {
    id: hashId,
    name: container.name,
    image: container.imageName,
    port: container.port?.toString() || '8080',
  };

  // Add placeholder env vars if container has requirements
  if (container.env && Object.keys(container.env).length > 0) {
    config.env = {};
    for (const key of Object.keys(container.env)) {
      config.env[key] = `\${${key}}`;
    }
  }

  return config;
}

interface SellerOptions {
  enabled: boolean;
  /** Per-call price in atomic USDC.e units (6 decimals). */
  priceAtomic: string;
}

/**
 * Build the x402Seller block: one direct-settlement service per container.
 * payTo is omitted — the seller falls back to chain.wallet.paymentAddress.
 */
function generateSellerConfig(
  selectedContainers: ConfigContainer[],
  network: NetworkPreset,
  opts: SellerOptions,
): object {
  return {
    enabled: true,
    facilitators: { [network.caip2]: network.facilitatorUrl },
    defaultAsset: {
      [network.caip2]: {
        address: network.usdceAddress,
        extra: { name: 'Bridged USDC', version: '2' },
      },
    },
    discovery: {
      enabled: false, // flip on + set publicBaseUrl to list on discovery (design 04)
      apiUrl: 'https://x402-discovery.hpp.io',
      publicBaseUrl: 'https://your-public-host.example.com',
      register: false,
    },
    services: selectedContainers.map((c) => ({
      name: (c.name ?? c.id).replace(/^noosphere-/, ''),
      containerId: c.id,
      settlement: 'direct',
      network: network.caip2,
      schemes: ['exact'],
      x402Price: opts.priceAtomic,
      inputSchema: { type: 'object' },
      description: `${c.name ?? c.id} compute, charged per call`,
    })),
  };
}

function generateConfig(
  selectedContainers: ConfigContainer[],
  network: NetworkPreset,
  seller?: SellerOptions,
): object {
  return {
    chain: {
      enabled: true,
      chainId: network.chainId,
      rpcUrl: network.rpcUrl,
      wsRpcUrl: network.wsRpcUrl,
      routerAddress: network.routerAddress,
      coordinatorAddress: network.coordinatorAddress,
      deploymentBlock: network.deploymentBlock,
      processingInterval: 5000,
      wallet: {
        keystorePath: './.noosphere/keystore.json',
        paymentAddress: '0x0000000000000000000000000000000000000000',
      },
    },
    containers: selectedContainers,
    verifiers: [
      {
        id: 'immediate-finalize-verifier',
        name: 'Immediate Finalize Verifier',
        address: network.verifierAddress,
        requiresProof: true,
        proofService: {
          image: network.proofServiceImage,
          port: '3001',
          command: 'npm start',
          env: {
            RPC_URL: network.rpcUrl,
            CHAIN_ID: network.chainId.toString(),
            IMMEDIATE_FINALIZE_VERIFIER_ADDRESS: network.verifierAddress,
            PRIVATE_KEY: '${PROOF_SERVICE_PRIVATE_KEY}',
          },
        },
      },
    ],
    scheduler: {
      enabled: true,
      cronIntervalMs: 60000,
      syncPeriodMs: 3000,
    },
    vrf: {
      enabled: false,
      vrfAddress: network.vrfAddress,
      vrngContainerUrl: 'http://localhost:8085',
      autoRegisterEpoch: true,
      epochLowThreshold: 100,
      pollingIntervalMs: 60000,
    },
    ...(seller?.enabled
      ? { x402Seller: generateSellerConfig(selectedContainers, network, seller) }
      : {}),
  };
}

async function interactiveMode(registry: Registry): Promise<ConfigContainer[]> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, resolve);
    });
  };

  console.log('\n📦 Available Containers:\n');
  const containers = Object.entries(registry.containers).filter(
    ([, c]) => c.statusCode === 'ACTIVE'
  );

  containers.forEach(([hashId, container], index) => {
    console.log(`  [${index + 1}] ${container.name}`);
    console.log(`      ${container.description || 'No description'}`);
    console.log(`      Port: ${container.port || 'N/A'}, Image: ${container.imageName}`);
    console.log();
  });

  const answer = await question(
    'Enter container numbers to add (comma-separated, e.g., "1,2") or "all": '
  );
  rl.close();

  const selectedContainers: ConfigContainer[] = [];

  if (answer.toLowerCase() === 'all') {
    for (const [hashId, container] of containers) {
      selectedContainers.push(generateContainerConfig(hashId, container));
    }
  } else {
    const indices = answer.split(',').map((s) => parseInt(s.trim(), 10) - 1);
    for (const index of indices) {
      if (index >= 0 && index < containers.length) {
        const [hashId, container] = containers[index];
        selectedContainers.push(generateContainerConfig(hashId, container));
      }
    }
  }

  return selectedContainers;
}

function parseNetwork(args: string[]): NetworkPreset {
  const networkIdx = args.indexOf('--network');
  const networkName = networkIdx >= 0 ? args[networkIdx + 1] : 'testnet';

  const preset = NETWORK_PRESETS[networkName];
  if (!preset) {
    throw new Error(`Unknown network: ${networkName}. Available: ${Object.keys(NETWORK_PRESETS).join(', ')}`);
  }

  console.log(`🌐 Network: ${networkName} (chainId: ${preset.chainId})`);
  return preset;
}

async function main() {
  const args = process.argv.slice(2);

  try {
    const network = parseNetwork(args);
    const registry = await fetchRegistry(network.registryUrl);

    // --list: List available containers
    if (args.includes('--list')) {
      listContainers(registry);
      return;
    }

    let selectedContainers: ConfigContainer[] = [];

    // --all: Add all containers
    if (args.includes('--all')) {
      for (const [hashId, container] of Object.entries(registry.containers)) {
        if (container.statusCode === 'ACTIVE') {
          selectedContainers.push(generateContainerConfig(hashId, container));
        }
      }
    }
    // --containers: Add specific containers by name
    else if (args.includes('--containers')) {
      const containerIndex = args.indexOf('--containers');
      const containerNames = args[containerIndex + 1]?.split(',') || [];

      for (const name of containerNames) {
        const found = findContainerByName(registry, name.trim());
        if (found) {
          const [hashId, container] = found;
          selectedContainers.push(generateContainerConfig(hashId, container));
          console.log(`✓ Added: ${container.name}`);
        } else {
          console.warn(`⚠️  Container not found: ${name}`);
        }
      }
    }
    // Interactive mode
    else {
      selectedContainers = await interactiveMode(registry);
    }

    if (selectedContainers.length === 0) {
      console.log('\n⚠️  No containers selected. Exiting.');
      return;
    }

    // x402 seller: --seller [--seller-price <atomic>] enables per-call selling
    // (direct settlement, no on-chain setup). Interactive mode asks.
    let seller: SellerOptions | undefined;
    const priceIdx = args.indexOf('--seller-price');
    const priceAtomic = priceIdx >= 0 ? args[priceIdx + 1] : '10000'; // 0.01 USDC.e
    if (!/^\d+$/.test(priceAtomic)) {
      console.error('Error: --seller-price must be an atomic integer (e.g. 10000 = 0.01 USDC.e)');
      process.exit(1);
    }
    if (args.includes('--seller')) {
      seller = { enabled: true, priceAtomic };
    } else if (!args.includes('--all') && !args.includes('--containers')) {
      // interactive path
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const q = (p: string) => new Promise<string>((res) => rl.question(p, res));
      const yn = await q('\n💰 Sell these containers per-call via x402? (y/N): ');
      if (yn.trim().toLowerCase().startsWith('y')) {
        const p = (await q(`   Price per call in atomic USDC.e [${priceAtomic}]: `)).trim() || priceAtomic;
        if (!/^\d+$/.test(p)) {
          console.log('   ⚠️  Invalid price, using default', priceAtomic);
          seller = { enabled: true, priceAtomic };
        } else {
          seller = { enabled: true, priceAtomic: p };
        }
      }
      rl.close();
    }

    // Generate config
    const config = generateConfig(selectedContainers, network, seller);

    // Check if config.json exists
    const outputPath = args.includes('--output')
      ? args[args.indexOf('--output') + 1]
      : CONFIG_OUTPUT_PATH;

    if (fs.existsSync(outputPath)) {
      console.log(`\n⚠️  ${outputPath} already exists.`);
      console.log('    Use --output <path> to specify a different output file.');
      console.log('    Or delete the existing file and run again.\n');

      // Still print the generated config for reference
      console.log('Generated config (not saved):');
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    // Write config
    fs.writeFileSync(outputPath, JSON.stringify(config, null, 2));
    console.log(`\n✓ Config generated: ${outputPath}`);
    console.log(`  Containers: ${selectedContainers.map((c) => c.name).join(', ')}`);
    if (seller?.enabled) {
      console.log(`  x402 seller: ${selectedContainers.length} service(s) at ${seller.priceAtomic} atomic USDC.e/call`);
    }
    console.log('\n📝 Next steps:');
    console.log('  1. Update wallet.paymentAddress in config.json (receives x402 payments too)');
    console.log('  2. Set environment variables for container env (if any)');
    console.log('  3. Run: npm run init  (to create keystore)');
    console.log('  4. Run: npm run agent (to start the agent)');
    if (seller?.enabled) {
      console.log('  5. Buyers can pay-per-call at POST /paid/compute/<service>');
      console.log('     To list on discovery: set x402Seller.discovery (see examples/hf-sentiment/README.md)');
    }
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}

main();
