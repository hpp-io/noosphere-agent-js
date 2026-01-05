/**
 * Send Test Request
 *
 * Manually trigger a test request to the Noosphere network
 *
 * Usage:
 *   npm run send-test-request
 */

import { config as loadEnv } from 'dotenv';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

loadEnv();

// ABIs (simplified - only the functions we need)
const CLIENT_ABI = [
  "function createSubscription(string containerId, uint16 redundancy, bool useInbox, address paymentToken, uint256 feeAmount, address wallet, address verifier, bytes32 routeId) external returns (uint64)",
  "function requestCompute(uint64 subscriptionId, bytes data) external"
];

const WALLET_FACTORY_ABI = [
  "function createWallet(address owner) external returns (address)",
  "function isValidWallet(address wallet) external view returns (bool)",
  "event WalletCreated(address indexed operator, address indexed owner, address walletAddress)"
];

async function main() {
  console.log('🚀 Sending Test Request to Noosphere Network\n');

  // Load configuration
  const configPath = path.join(process.cwd(), 'config.json');
  const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY environment variable is required');
  }

  // Connect to network
  console.log('📡 Connecting to network...');
  const provider = new ethers.JsonRpcProvider(configData.chain.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log(`  Wallet Address: ${wallet.address}`);
  const balance = await provider.getBalance(wallet.address);
  console.log(`  Balance: ${ethers.formatEther(balance)} ETH\n`);

  // Contract addresses (Sepolia testnet deployment)
  const CLIENT_ADDRESS = process.env.CLIENT_ADDRESS || '0xa1e37cd4a1804c860acf4c87256d3b4334fbdf0a';
  const WALLET_FACTORY_ADDRESS = process.env.WALLET_FACTORY_ADDRESS || '0x3c50db71f27401e18b8498fcaf1a4988ebeff0c4';

  console.log('📋 Contract Addresses:');
  console.log(`  Client: ${CLIENT_ADDRESS}`);
  console.log(`  WalletFactory: ${WALLET_FACTORY_ADDRESS}\n`);

  // Initialize contracts
  const client = new ethers.Contract(CLIENT_ADDRESS, CLIENT_ABI, wallet);
  const walletFactory = new ethers.Contract(WALLET_FACTORY_ADDRESS, WALLET_FACTORY_ABI, wallet);

  // Create payment wallet
  console.log('💳 Creating payment wallet...');
  const createWalletTx = await walletFactory.createWallet(wallet.address);
  const createWalletReceipt = await createWalletTx.wait();

  // Parse WalletCreated event to get wallet address
  const walletCreatedEvent = createWalletReceipt.logs.find((log: any) => {
    try {
      const parsed = walletFactory.interface.parseLog(log);
      return parsed?.name === 'WalletCreated';
    } catch {
      return false;
    }
  });

  if (!walletCreatedEvent) {
    throw new Error('WalletCreated event not found');
  }

  const parsedEvent = walletFactory.interface.parseLog(walletCreatedEvent);
  const paymentWallet = parsedEvent?.args.walletAddress;

  console.log(`  ✓ Payment wallet created: ${paymentWallet}`);

  // Fund the payment wallet
  console.log('  Funding payment wallet with 0.0003 ETH...');
  const fundTx = await wallet.sendTransaction({
    to: paymentWallet,
    value: ethers.parseEther('0.0003')
  });
  await fundTx.wait();
  console.log('  ✓ Payment wallet funded');

  const walletBalance = await provider.getBalance(paymentWallet);
  console.log(`  Balance: ${ethers.formatEther(walletBalance)} ETH\n`);

  // Subscription parameters
  const containerId = 'noosphere-hello-world'; // or 'noosphere-llm'
  const redundancy = 1;
  const useInbox = false;
  const paymentToken = ethers.ZeroAddress; // Native ETH
  const feeAmount = ethers.parseUnits('1', 'gwei'); // 1 gwei fee
  const verifier = ethers.ZeroAddress; // No verifier
  const routeId = ethers.encodeBytes32String('Coordinator_v1.0.0');

  console.log('📦 Creating Subscription:');
  console.log(`  Container: ${containerId}`);
  console.log(`  Redundancy: ${redundancy}`);
  console.log(`  Fee: ${ethers.formatUnits(feeAmount, 'gwei')} gwei (${ethers.formatEther(feeAmount)} ETH)\n`);

  // Create subscription
  console.log('⏳ Creating subscription...');
  const createTx = await client.createSubscription(
    containerId,
    redundancy,
    useInbox,
    paymentToken,
    feeAmount,
    paymentWallet,
    verifier,
    routeId,
    { gasLimit: 500000 }
  );

  const createReceipt = await createTx.wait();
  console.log(`  ✓ Transaction: ${createReceipt.hash}`);

  // Parse subscription ID from logs (simplified - assumes last log)
  const subscriptionId = createReceipt.logs[createReceipt.logs.length - 1].topics[1];
  console.log(`  ✓ Subscription ID: ${BigInt(subscriptionId)}\n`);

  // Trigger request
  console.log('🎯 Triggering Compute Request...');
  const requestData = ethers.toUtf8Bytes(''); // Empty data for hello-world

  const requestTx = await client.requestCompute(
    BigInt(subscriptionId),
    requestData,
    { gasLimit: 500000 }
  );

  const requestReceipt = await requestTx.wait();
  console.log(`  ✓ Transaction: ${requestReceipt.hash}\n`);

  console.log('✅ Test Request Sent Successfully!\n');
  console.log('📊 Next Steps:');
  console.log('  1. Check agent logs for RequestStarted event');
  console.log('  2. Watch for container execution');
  console.log('  3. Wait for result transaction');
  console.log(`  4. View on explorer: https://explorer.hpp.io/tx/${requestReceipt.hash}\n`);
}

main().catch((error) => {
  console.error('\n❌ Error:', error.message);
  if (error.stack) {
    console.error('\nStack trace:');
    console.error(error.stack);
  }
  process.exit(1);
});
