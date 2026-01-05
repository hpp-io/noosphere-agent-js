/**
 * Initialize Keystore Script
 *
 * Run this script once to create your agent's keystore file.
 * Usage: PRIVATE_KEY=0x... KEYSTORE_PASSWORD=... node scripts/init-keystore.ts
 */

import { config as loadEnv } from 'dotenv';
import { ethers } from 'ethers';
import { KeystoreManager } from '@noosphere/crypto';
import * as fs from 'fs';
import * as path from 'path';

loadEnv();

async function main() {
  console.log('🔐 Initializing Noosphere Agent Keystore\n');

  // Load configuration from config.json
  const configPath = path.join(process.cwd(), 'config.json');
  const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Get secrets from environment variables
  const privateKey = process.env.PRIVATE_KEY;
  const password = process.env.KEYSTORE_PASSWORD;
  const rpcUrl = configData.chain.rpcUrl;
  const keystorePath = configData.chain.wallet.keystorePath;

  if (!privateKey) {
    throw new Error('PRIVATE_KEY environment variable is required');
  }

  if (!password) {
    throw new Error('KEYSTORE_PASSWORD environment variable is required');
  }

  // Validate private key format
  if (!privateKey.match(/^0x[0-9a-fA-F]{64}$/)) {
    throw new Error('Invalid private key format. Must be 0x followed by 64 hex characters');
  }

  // Check if keystore already exists
  if (fs.existsSync(keystorePath)) {
    console.error(`❌ Keystore already exists at ${keystorePath}`);
    console.error('   Delete it first if you want to create a new one.');
    process.exit(1);
  }

  // Create provider
  console.log('Connecting to blockchain...');
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // Get wallet address for display
  const wallet = new ethers.Wallet(privateKey);
  console.log(`✓ Wallet address: ${wallet.address}\n`);

  // Initialize keystore
  console.log(`Creating keystore at ${keystorePath}...`);
  await KeystoreManager.initialize(
    keystorePath,
    password,
    privateKey,
    provider
  );

  console.log('\n✅ Keystore initialized successfully!');
  console.log('\nIMPORTANT:');
  console.log('  1. Backup the keystore file: ' + keystorePath);
  console.log('  2. Store the password securely');
  console.log('  3. Never commit the keystore file to git');
  console.log('  4. Fund the wallet address with ETH for gas fees');
  console.log('\nYou can now run the agent with: npm run agent');
}

main().catch((error) => {
  console.error('\n❌ Error:', error.message);
  process.exit(1);
});
