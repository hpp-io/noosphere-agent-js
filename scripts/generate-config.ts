#!/usr/bin/env tsx
/**
 * CLI tool to generate config.json from registry
 *
 * Usage:
 *   npm run generate:config                    # Interactive mode - select containers
 *   npm run generate:config -- --list          # List available containers
 *   npm run generate:config -- --all           # Add all containers
 *   npm run generate:config -- --containers noosphere-hello-world,noosphere-llm
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const REGISTRY_URL = 'https://raw.githubusercontent.com/hpp-io/noosphere-registry/main/registry.json';
const CONFIG_TEMPLATE_PATH = './config.template.json';
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

async function fetchRegistry(): Promise<Registry> {
  console.log('📡 Fetching registry from', REGISTRY_URL);
  const response = await fetch(REGISTRY_URL);
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

function generateConfig(selectedContainers: ConfigContainer[]): object {
  return {
    chain: {
      enabled: true,
      rpcUrl: 'https://sepolia.hpp.io',
      wsRpcUrl: 'wss://sepolia.hpp.io',
      routerAddress: '0x31B0d4038b65E2c17c769Bad1eEeA18EEb1dBdF6',
      coordinatorAddress: '0x5e055cd47e5d16f3645174cfe2423d61fe8f4585',
      deploymentBlock: 7776,
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
        address: '0x672c325941E3190838523052ebFF122146864EAd',
        requiresProof: true,
        proofService: {
          image: 'ghcr.io/hpp-io/noosphere-proof-creator:dev',
          port: '3001',
          command: 'npm start',
          env: {
            RPC_URL: 'https://sepolia.hpp.io',
            CHAIN_ID: '181228',
            IMMEDIATE_FINALIZE_VERIFIER_ADDRESS: '0x672c325941E3190838523052ebFF122146864EAd',
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
    logging: {
      level: 'info',
    },
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

async function main() {
  const args = process.argv.slice(2);

  try {
    const registry = await fetchRegistry();

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

    // Generate config
    const config = generateConfig(selectedContainers);

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
    console.log('\n📝 Next steps:');
    console.log('  1. Update wallet.paymentAddress in config.json');
    console.log('  2. Set environment variables for container env (if any)');
    console.log('  3. Run: npm run init  (to create keystore)');
    console.log('  4. Run: npm run agent (to start the agent)');
  } catch (error) {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  }
}

main();
