/**
 * Approve Payment Wallet
 *
 * Approve agent EOA to spend from payment wallet
 * Usage: PRIVATE_KEY=0x... npm run approve:wallet
 */

import { config as loadEnv } from 'dotenv';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

loadEnv();

async function main() {
  console.log('🔐 Approving Payment Wallet for Agent EOA\n');

  // Load configuration
  const configPath = path.join(process.cwd(), 'config.json');
  const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY environment variable is required');
  }

  const rpcUrl = configData.chain.rpcUrl;
  const paymentWalletAddress = configData.chain.wallet.paymentAddress;

  if (!paymentWalletAddress) {
    throw new Error('No payment wallet found in config.json');
  }

  // Connect to network
  console.log('📡 Connecting to blockchain...');
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log(`  Agent EOA: ${wallet.address}`);
  console.log(`  Payment Wallet: ${paymentWalletAddress}\n`);

  // Check current balance
  const balance = await provider.getBalance(wallet.address);
  console.log(`  Balance: ${ethers.formatEther(balance)} ETH\n`);

  // Approve agent EOA to spend from payment wallet
  console.log('📝 Approving agent EOA as spender...');
  const walletAbi = [
    "function approve(address spender, address token, uint256 amount) external",
    "function allowance(address owner, address spender) external view returns (uint256)"
  ];
  const paymentWalletContract = new ethers.Contract(
    paymentWalletAddress,
    walletAbi,
    wallet
  );

  // Approve agent EOA for native ETH (ZeroAddress) with max allowance
  const approveTx = await paymentWalletContract.approve(
    wallet.address, // spender = agent EOA
    ethers.ZeroAddress, // token = native ETH
    ethers.MaxUint256 // amount = unlimited
  );

  console.log(`  ⏳ Transaction sent: ${approveTx.hash}`);
  const receipt = await approveTx.wait();
  console.log(`  ✓ Transaction confirmed (block ${receipt.blockNumber})\n`);

  console.log('✅ Approval completed successfully!\n');
  console.log('Summary:');
  console.log(`  ✓ Agent EOA: ${wallet.address}`);
  console.log(`  ✓ Payment Wallet: ${paymentWalletAddress}`);
  console.log(`  ✓ Spender: ${wallet.address}`);
  console.log(`  ✓ Token: ${ethers.ZeroAddress} (Native ETH)`);
  console.log(`  ✓ Allowance: Unlimited\n`);
  console.log('The agent can now submit results and receive payments!');
}

main().catch((error) => {
  console.error('\n❌ Error:', error.message);
  if (error.stack) {
    console.error('\nStack trace:');
    console.error(error.stack);
  }
  process.exit(1);
});
