import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

// Set test environment BEFORE any imports
const testDataDir = join(process.cwd(), '.noosphere-test');
const sdkDataDir = join(process.cwd(), '.noosphere'); // SDK uses this path
const testKeystorePath = join(testDataDir, 'keystore.json');
const testConfigPath = join(process.cwd(), 'config.test.json');
const testRegistryPath = join(testDataDir, 'registry.json');
const sdkRegistryPath = join(sdkDataDir, 'registry.json');

process.env.NOOSPHERE_DATA_DIR = testDataDir;
process.env.NOOSPHERE_CONFIG_PATH = testConfigPath;
process.env.KEYSTORE_PASSWORD = 'test-password-12345';

// Create test data directory
if (!existsSync(testDataDir)) {
  mkdirSync(testDataDir, { recursive: true });
}

// Create SDK data directory (RegistryManager uses this)
if (!existsSync(sdkDataDir)) {
  mkdirSync(sdkDataDir, { recursive: true });
}

// Create test keystore (minimal valid structure)
const testKeystore = {
  address: "abda a7ce871aa8d3e45f98d47762672204c90a26",
  id: "test-keystore-id",
  version: 3,
  crypto: {
    cipher: "aes-128-ctr",
    cipherparams: { iv: "0000000000000000" },
    ciphertext: "0000000000000000000000000000000000000000000000000000000000000000",
    kdf: "scrypt",
    kdfparams: {
      dklen: 32,
      n: 1,
      p: 1,
      r: 8,
      salt: "0000000000000000000000000000000000000000000000000000000000000000"
    },
    mac: "0000000000000000000000000000000000000000000000000000000000000000"
  }
};

writeFileSync(testKeystorePath, JSON.stringify(testKeystore, null, 2));

// Create test config with chain disabled
const testConfig = {
  chain: {
    enabled: false,
    rpcUrl: "https://sepolia.hpp.io",
    wsRpcUrl: null,
    routerAddress: "0x31B0d4038b65E2c17c769Bad1eEeA18EEb1dBdF6",
    coordinatorAddress: "0x5e055cd47E5d16f3645174Cfe2423D61fe8F4585",
    deploymentBlock: 7776,
    processingInterval: 5000,
    wallet: {
      keystorePath: testKeystorePath,
      paymentAddress: "0x0000000000000000000000000000000000000000"
    }
  },
  scheduler: {
    enabled: false,
    cronIntervalMs: 60000,
    syncPeriodMs: 3000
  },
  retry: {
    maxRetries: 3,
    retryIntervalMs: 30000
  },
  containers: [],
  verifiers: []
};

writeFileSync(testConfigPath, JSON.stringify(testConfig, null, 2));

// Create test registry
const testRegistry = {
  containers: [],
  verifiers: []
};

writeFileSync(testRegistryPath, JSON.stringify(testRegistry, null, 2));

// Create SDK registry (for RegistryManager)
if (!existsSync(sdkRegistryPath)) {
  writeFileSync(sdkRegistryPath, JSON.stringify(testRegistry, null, 2));
}

// Clear any cached config
import { clearConfigCache } from '../lib/config';
clearConfigCache();

console.log('Test environment setup complete:', {
  dataDir: testDataDir,
  configPath: testConfigPath,
  keystorePath: testKeystorePath
});
