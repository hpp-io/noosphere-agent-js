/**
 * Setup Agent Wallet
 *
 * Creates a new keystore with EOA and WalletFactory payment wallet for the agent
 * Usage: PRIVATE_KEY=0x... KEYSTORE_PASSWORD=... WALLET_FACTORY_ADDRESS=0x... npm run setup:wallet
 */

import { config as loadEnv } from 'dotenv';
import { ethers } from 'ethers';
import { KeystoreManager, WalletManager } from '@noosphere/crypto';
import * as fs from 'fs';
import * as path from 'path';

loadEnv();

async function main() {
  console.log('🔐 Setting up Noosphere Agent Wallet\n');

  // Load configuration from config.json (or NOOSPHERE_CONFIG_PATH)
  const configPath = process.env.NOOSPHERE_CONFIG_PATH
    ? path.resolve(process.env.NOOSPHERE_CONFIG_PATH)
    : path.join(process.cwd(), 'config.json');
  console.log(`📄 Config: ${configPath}`);
  const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Get secrets from environment variables
  const privateKey = process.env.PRIVATE_KEY;
  const password = process.env.KEYSTORE_PASSWORD;
  const walletFactoryAddress = process.env.WALLET_FACTORY_ADDRESS;
  const rpcUrl = configData.chain.rpcUrl;
  const keystorePath = configData.chain.wallet.keystorePath;

  if (!privateKey) {
    throw new Error('PRIVATE_KEY environment variable is required');
  }

  if (!password) {
    throw new Error('KEYSTORE_PASSWORD environment variable is required');
  }

  if (!walletFactoryAddress) {
    throw new Error('WALLET_FACTORY_ADDRESS environment variable is required');
  }

  // Validate private key format
  if (!privateKey.match(/^0x[0-9a-fA-F]{64}$/)) {
    throw new Error('Invalid private key format. Must be 0x followed by 64 hex characters');
  }

  // Check if keystore already exists
  if (fs.existsSync(keystorePath)) {
    console.log(`⚠️  Keystore already exists at ${keystorePath}`);
    console.log('   Deleting old keystore...\n');
    fs.unlinkSync(keystorePath);
  }

  // Create provider
  console.log('📡 Connecting to blockchain...');
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // Get wallet address for display
  const wallet = new ethers.Wallet(privateKey, provider);
  console.log(`  ✓ Agent EOA: ${wallet.address}`);

  // Check balance
  const balance = await provider.getBalance(wallet.address);
  console.log(`  ✓ Balance: ${ethers.formatEther(balance)} ETH\n`);

  if (balance === 0n) {
    console.warn('⚠️  Warning: Agent wallet has zero balance. Fund it with ETH for gas fees.');
  }

  // Step 1: Initialize keystore with EOA
  console.log('📝 Step 1: Creating keystore with EOA...');
  await KeystoreManager.initialize(
    keystorePath,
    password,
    privateKey,
    provider
  );
  console.log('✓ Keystore created\n');

  // Step 2: Create payment wallet using WalletFactory
  console.log('📝 Step 2: Creating payment wallet via WalletFactory...');
  console.log(`  WalletFactory: ${walletFactoryAddress}`);

  const keystoreManager = new KeystoreManager(keystorePath, password);
  await keystoreManager.load();

  const walletManager = new WalletManager(
    privateKey,
    provider,
    keystoreManager
  );

  // Create CA wallet for the agent (owner = agent's EOA)
  const { walletAddress, txHash } = await walletManager.createPaymentWallet(
    walletFactoryAddress,
    wallet.address, // owner is agent's EOA
    undefined // no subscription ID for agent's wallet
  );

  console.log(`  ✓ Payment Wallet created: ${walletAddress}`);
  console.log(`  ✓ Transaction: ${txHash}\n`);

  // Step 2.5: Approve agent EOA to spend from payment wallet
  console.log('📝 Step 2.5: Approving agent EOA as spender...');
  const walletAbi = [
    "function approve(address spender, address token, uint256 amount) external"
  ];
  const paymentWalletContract = new ethers.Contract(walletAddress, walletAbi, wallet);

  // Approve agent EOA for native ETH (ZeroAddress) with max allowance
  const approveTx = await paymentWalletContract.approve(
    wallet.address, // spender = agent EOA
    ethers.ZeroAddress, // token = native ETH
    ethers.MaxUint256 // amount = unlimited
  );
  await approveTx.wait();
  console.log(`  ✓ Approved agent EOA as spender: ${wallet.address}`);
  console.log(`  ✓ Transaction: ${approveTx.hash}\n`);

  // Step 2.6: Deposit ETH to payment wallet for verification escrow
  console.log('📝 Step 2.6: Depositing ETH to payment wallet for escrow...');
  const depositAmount = ethers.parseUnits('1000', 'gwei'); // 1000 gwei for escrow
  const depositTx = await wallet.sendTransaction({
    to: walletAddress,
    value: depositAmount,
  });
  await depositTx.wait();
  console.log(`  ✓ Deposited ${ethers.formatUnits(depositAmount, 'gwei')} gwei to Payment Wallet`);
  console.log(`  ✓ Transaction: ${depositTx.hash}\n`);

  // Step 3: Update config.json with payment wallet address
  console.log('📝 Step 3: Updating config.json...');
  configData.chain.wallet.paymentAddress = walletAddress;
  fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
  console.log(`  ✓ Updated paymentAddress to: ${walletAddress}\n`);

  console.log('✅ Agent wallet setup completed successfully!\n');
  console.log('Summary:');
  console.log(`  ✓ Agent EOA: ${wallet.address}`);
  console.log(`  ✓ Payment Wallet (CA): ${walletAddress}`);
  console.log(`  ✓ Keystore: ${keystorePath}`);
  console.log(`  ✓ Config: ${configPath}`);
  console.log('\nNext steps:');
  console.log('  1. Start the agent: npm run agent');
  console.log('  2. Send a test request: npm run send:request');
}

main().catch((error) => {
  console.error('\n❌ Error:', error.message);
  if (error.stack) {
    console.error('\nStack trace:');
    console.error(error.stack);
  }
  process.exit(1);
});
