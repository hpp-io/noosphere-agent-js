import { NextResponse } from 'next/server';
import { KeystoreManager } from '@noosphere/crypto';
import { JsonRpcProvider } from 'ethers';
import * as fs from 'fs/promises';
import { loadConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Load configuration from config.json
    const config = loadConfig();
    const password = config.secrets.keystorePassword;

    const provider = new JsonRpcProvider(config.chain.rpcUrl);

    // Load keystore to get wallet info
    const keystoreData = await fs.readFile(config.chain.wallet.keystorePath, 'utf-8');
    const keystore = await KeystoreManager.importKeystore(
      config.chain.wallet.keystorePath,
      password,
      keystoreData
    );
    const eoaAddress = keystore.getEOAAddress();

    // Get EOA balance
    const balance = await provider.getBalance(eoaAddress);
    const balanceInGwei = Number(balance) / 1e9;

    // Get payment wallet address and balance from config
    const paymentWalletAddress = config.chain.wallet.paymentAddress;
    const paymentWalletBalance = await provider.getBalance(paymentWalletAddress);
    const paymentWalletBalanceInGwei = Number(paymentWalletBalance) / 1e9;

    return NextResponse.json({
      agentAddress: eoaAddress,
      balance: balanceInGwei.toFixed(4),
      paymentWallets: [{
        address: paymentWalletAddress,
        balance: paymentWalletBalanceInGwei.toFixed(4),
      }],
      rpcUrl: config.chain.rpcUrl,
      routerAddress: config.chain.routerAddress,
      coordinatorAddress: config.chain.coordinatorAddress,
    });
  } catch (error) {
    console.error('Error loading agent status:', error);
    return NextResponse.json(
      { error: 'Failed to load agent status', details: (error as Error).message },
      { status: 500 }
    );
  }
}
