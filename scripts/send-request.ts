/**
 * Send Request to Noosphere Network
 *
 * Send either a one-time or scheduled request to the Noosphere network
 *
 * Usage:
 *   One-time request:
 *     PRIVATE_KEY=0x... CLIENT_ADDRESS=0x... WALLET_FACTORY_ADDRESS=0x... npm run send:request
 *
 *   Scheduled request:
 *     PRIVATE_KEY=0x... SCHEDULED_CLIENT_ADDRESS=0x... WALLET_FACTORY_ADDRESS=0x... npm run send:request
 *
 * Environment Variables:
 *   PRIVATE_KEY - Your wallet private key
 *   CLIENT_ADDRESS - ComputeClient contract address (for one-time)
 *   SCHEDULED_CLIENT_ADDRESS - ScheduledComputeClient contract address (for scheduled)
 *   WALLET_FACTORY_ADDRESS - WalletFactory contract address
 *   RPC_URL - Optional RPC URL (default: https://sepolia.hpp.io)
 *   CONTAINER_ID - Container ID (default: noosphere-hello-world)
 *   MAX_EXECUTIONS - Max executions for scheduled (default: 3)
 *   INTERVAL_SECONDS - Interval in seconds for scheduled (default: 180)
 */

import { config as loadEnv } from 'dotenv';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

loadEnv();

// ABIs
const CLIENT_ABI = [
  "function createSubscription(string containerId, uint16 redundancy, bool useInbox, address paymentToken, uint256 feeAmount, address wallet, address verifier, bytes32 routeId) external returns (uint64)",
  "function requestCompute(uint64 subscriptionId, bytes data) external"
];

const SCHEDULED_CLIENT_ABI = [
  "function createComputeSubscription(string containerId, uint32 maxExecutions, uint32 intervalSeconds, uint16 redundancy, bool useDeliveryInbox, address feeToken, uint256 feeAmount, address wallet, address verifier, bytes32 routeId) external returns (uint64)",
  "function getComputeInputs(uint64 subscriptionId, uint32 interval, uint32 timestamp, address caller) external view returns (bytes)"
];

const WALLET_FACTORY_ABI = [
  "function createWallet(address owner) external returns (address)",
  "function isValidWallet(address wallet) external view returns (bool)",
  "event WalletCreated(address indexed operator, address indexed owner, address walletAddress)"
];

interface RequestConfig {
  containerId: string;
  data?: string;
  maxExecutions?: number;
  intervalSeconds?: number;
  redundancy?: number;
  useInbox?: boolean;
  feeAmount?: string;
}

async function sendOneTimeRequest(
  provider: ethers.Provider,
  signer: ethers.Signer,
  clientAddress: string,
  walletFactoryAddress: string,
  config: RequestConfig
) {
  console.log('📋 Sending one-time request\n');

  const client = new ethers.Contract(clientAddress, CLIENT_ABI, signer);
  const walletFactory = new ethers.Contract(walletFactoryAddress, WALLET_FACTORY_ABI, signer);

  // Get or create wallet
  const signerAddress = await signer.getAddress();
  let paymentWallet: string;

  console.log('🔍 Checking for existing payment wallet...');
  const filter = walletFactory.filters.WalletCreated(null, signerAddress);
  const events = await walletFactory.queryFilter(filter);

  if (events.length > 0) {
    paymentWallet = (events[events.length - 1] as any).args[2];
    console.log(`✓ Found existing wallet: ${paymentWallet}\n`);
  } else {
    console.log('📝 Creating new payment wallet...');
    const tx = await walletFactory.createWallet(signerAddress);
    const receipt = await tx.wait();
    const event = receipt!.logs.find((log: any) => {
      try {
        return walletFactory.interface.parseLog(log)?.name === 'WalletCreated';
      } catch {
        return false;
      }
    });
    paymentWallet = walletFactory.interface.parseLog(event!)!.args[2];
    console.log(`✓ Created wallet: ${paymentWallet}\n`);
  }

  // Create subscription
  console.log('📝 Creating subscription...');
  const createTx = await client.createSubscription(
    config.containerId,
    config.redundancy || 1,
    config.useInbox || false,
    ethers.ZeroAddress,
    config.feeAmount || '100',
    paymentWallet,
    ethers.ZeroAddress,
    ethers.ZeroHash
  );
  const createReceipt = await createTx.wait();

  console.log(`✓ Subscription created (tx: ${createReceipt!.hash})\n`);

  // Send request
  console.log('📤 Sending compute request...');
  const requestTx = await client.requestCompute(
    1, // subscriptionId
    ethers.toUtf8Bytes(config.data || '{"model":"openai/gpt-5","prompt":"Hello"}')
  );
  const requestReceipt = await requestTx.wait();

  console.log(`✓ Request sent (tx: ${requestReceipt!.hash})`);
  console.log('✅ One-time request completed!\n');
}

async function sendScheduledRequest(
  provider: ethers.Provider,
  signer: ethers.Signer,
  scheduledClientAddress: string,
  walletFactoryAddress: string,
  config: RequestConfig
) {
  console.log('📋 Sending scheduled request\n');

  const scheduledClient = new ethers.Contract(scheduledClientAddress, SCHEDULED_CLIENT_ABI, signer);
  const walletFactory = new ethers.Contract(walletFactoryAddress, WALLET_FACTORY_ABI, signer);

  // Get or create wallet
  const signerAddress = await signer.getAddress();
  let paymentWallet: string;

  console.log('🔍 Checking for existing payment wallet...');
  const filter = walletFactory.filters.WalletCreated(null, signerAddress);
  const events = await walletFactory.queryFilter(filter);

  if (events.length > 0) {
    paymentWallet = (events[events.length - 1] as any).args[2];
    console.log(`✓ Found existing wallet: ${paymentWallet}\n`);
  } else {
    console.log('📝 Creating new payment wallet...');
    const tx = await walletFactory.createWallet(signerAddress);
    const receipt = await tx.wait();
    const event = receipt!.logs.find((log: any) => {
      try {
        return walletFactory.interface.parseLog(log)?.name === 'WalletCreated';
      } catch {
        return false;
      }
    });
    paymentWallet = walletFactory.interface.parseLog(event!)!.args[2];
    console.log(`✓ Created wallet: ${paymentWallet}\n`);
  }

  // Create scheduled subscription
  console.log('📝 Creating scheduled subscription...');
  console.log(`  Container: ${config.containerId}`);
  console.log(`  Max Executions: ${config.maxExecutions || 3}`);
  console.log(`  Interval: ${config.intervalSeconds || 180}s\n`);

  const createTx = await scheduledClient.createComputeSubscription(
    config.containerId,
    config.maxExecutions || 3,
    config.intervalSeconds || 180,
    config.redundancy || 1,
    config.useInbox || false,
    ethers.ZeroAddress,
    config.feeAmount || '100',
    paymentWallet,
    ethers.ZeroAddress,
    ethers.ZeroHash
  );
  const createReceipt = await createTx.wait();

  console.log(`✓ Scheduled subscription created (tx: ${createReceipt!.hash})`);
  console.log('✅ The scheduler will automatically trigger requests at each interval!\n');
}

async function main() {
  console.log('🚀 Sending Request to Noosphere Network\n');

  // Get environment variables
  const privateKey = process.env.PRIVATE_KEY;
  const clientAddress = process.env.CLIENT_ADDRESS;
  const scheduledClientAddress = process.env.SCHEDULED_CLIENT_ADDRESS;
  const walletFactoryAddress = process.env.WALLET_FACTORY_ADDRESS;
  const rpcUrl = process.env.RPC_URL || 'https://sepolia.hpp.io';

  if (!privateKey) {
    console.error('❌ PRIVATE_KEY environment variable is required');
    process.exit(1);
  }

  if (!walletFactoryAddress) {
    console.error('❌ WALLET_FACTORY_ADDRESS environment variable is required');
    process.exit(1);
  }

  if (!clientAddress && !scheduledClientAddress) {
    console.error('❌ Either CLIENT_ADDRESS or SCHEDULED_CLIENT_ADDRESS is required');
    process.exit(1);
  }

  // Setup provider and signer
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);

  console.log('📡 Connected to:', rpcUrl);
  console.log('👤 Signer address:', await signer.getAddress());
  console.log('💰 Balance:', ethers.formatEther(await provider.getBalance(await signer.getAddress())), 'ETH\n');

  // Request configuration
  const config: RequestConfig = {
    containerId: process.env.CONTAINER_ID || 'noosphere-hello-world',
    data: process.env.REQUEST_DATA,
    maxExecutions: process.env.MAX_EXECUTIONS ? parseInt(process.env.MAX_EXECUTIONS) : undefined,
    intervalSeconds: process.env.INTERVAL_SECONDS ? parseInt(process.env.INTERVAL_SECONDS) : undefined,
    redundancy: process.env.REDUNDANCY ? parseInt(process.env.REDUNDANCY) : undefined,
    useInbox: process.env.USE_INBOX === 'true',
    feeAmount: process.env.FEE_AMOUNT,
  };

  try {
    if (scheduledClientAddress) {
      await sendScheduledRequest(provider, signer, scheduledClientAddress, walletFactoryAddress, config);
    } else if (clientAddress) {
      await sendOneTimeRequest(provider, signer, clientAddress, walletFactoryAddress, config);
    }
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main().catch(console.error);
