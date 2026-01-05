import { NextResponse } from 'next/server';
import { JsonRpcProvider, Contract, Interface } from 'ethers';
import { KeystoreManager } from '@noosphere/crypto';
import * as fs from 'fs/promises';
import { loadConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

// Extended Coordinator ABI with events and view functions
const COORDINATOR_ABI = [
  'event ComputeDelivered(bytes32 indexed requestId, address indexed nodeWallet, uint16 numRedundantDeliveries)',
  'event RequestStarted(bytes32 indexed requestId, uint64 indexed subscriptionId, bytes32 indexed containerId, tuple(bytes32 requestId, uint64 subscriptionId, bytes32 containerId, uint32 interval, bool useDeliveryInbox, uint16 redundancy, address walletAddress, uint256 feeAmount, address feeToken, address verifier, address coordinator) commitment)',
  'function getSubscription(uint32 subscriptionId) view returns (tuple(address owner, uint32 activeAt, uint32 period, uint32 frequency, uint16 redundancy, bytes32 containerId, bool lazy, address verifier, uint256 paymentAmount, address paymentToken, address wallet))',
  'function reportComputeResult(uint32 deliveryInterval, bytes input, bytes output, bytes proof, bytes commitmentData, address nodeWallet)',
];

interface HistoryEntry {
  requestId: string;
  subscriptionId: number;
  interval: number;
  blockNumber: number;
  timestamp: number;
  transactionHash: string;
  containerId: string;
  redundancy: number;
  feeAmount: string;
  feeToken: string;
  gasFee: string;
  feeEarned: string;
  isPenalty: boolean;
  input: string;
  output: string;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = parseInt(searchParams.get('offset') || '0');

    // Load configuration
    const config = loadConfig();

    // Load keystore to get payment wallet address
    const keystoreData = await fs.readFile(config.chain.wallet.keystorePath, 'utf-8');
    const keystore = await KeystoreManager.importKeystore(
      config.chain.wallet.keystorePath,
      config.secrets.keystorePassword,
      keystoreData
    );
    const agentAddress = keystore.getEOAAddress();
    const paymentWallet = config.chain.wallet.paymentAddress;

    // Connect to blockchain
    const provider = new JsonRpcProvider(config.chain.rpcUrl);
    const coordinator = new Contract(config.chain.coordinatorAddress, COORDINATOR_ABI, provider);

    // Query ComputeDelivered events filtered by payment wallet
    const filter = coordinator.filters.ComputeDelivered(null, paymentWallet);
    const deliveredEvents = await coordinator.queryFilter(filter, config.chain.deploymentBlock);

    console.log(`Found ${deliveredEvents.length} ComputeDelivered events for payment wallet ${paymentWallet}`);

    // Get all RequestStarted events to match with ComputeDelivered
    const requestStartedFilter = coordinator.filters.RequestStarted();
    const requestStartedEvents = await coordinator.queryFilter(requestStartedFilter, config.chain.deploymentBlock);

    console.log(`Found ${requestStartedEvents.length} RequestStarted events`);

    // Create a map of requestId -> RequestStarted event
    const requestStartedMap = new Map();
    requestStartedEvents.forEach(event => {
      const requestId = event.args![0].toLowerCase();
      requestStartedMap.set(requestId, event);
    });

    console.log(`RequestStarted map has ${requestStartedMap.size} entries`);

    // Sort events by block number descending (newest first) BEFORE pagination
    const sortedEvents = deliveredEvents.sort((a, b) => b.blockNumber - a.blockNumber);

    // Process events with pagination
    const paginatedEvents = sortedEvents.slice(offset, offset + limit);

    // Fetch details for each delivered event
    const history: HistoryEntry[] = await Promise.all(
      paginatedEvents.map(async (event) => {
        const block = await event.getBlock();
        const requestId = event.args![0];
        const requestIdKey = requestId.toLowerCase();

        // Find corresponding RequestStarted event
        const requestStartedEvent = requestStartedMap.get(requestIdKey);

        if (!requestStartedEvent) {
          console.warn(`No RequestStarted event found for requestId ${requestId}`);
          console.warn(`Available requestIds: ${Array.from(requestStartedMap.keys()).join(', ')}`);
          return null;
        }

        const commitment = requestStartedEvent.args![3]; // The commitment struct is the 4th argument (index 3)
        const subscriptionId = Number(commitment.subscriptionId);
        const containerId = commitment.containerId;
        const interval = Number(commitment.interval);
        const redundancy = Number(commitment.redundancy);
        const feeAmount = commitment.feeAmount.toString();
        const feeToken = commitment.feeToken;

        // Get transaction receipt for gas fee calculation
        const receipt = await provider.getTransactionReceipt(event.transactionHash);
        const tx = await provider.getTransaction(event.transactionHash);

        if (!receipt || !tx) {
          console.warn(`Transaction not found: ${event.transactionHash}`);
          return null;
        }

        // Calculate gas fee
        const gasUsed = receipt.gasUsed;
        const gasPrice = tx.gasPrice || 0n;
        const gasFee = (gasUsed * gasPrice).toString();

        // Decode transaction data to extract input and output
        let input = '';
        let output = '';

        try {
          const iface = new Interface(COORDINATOR_ABI);
          const decoded = iface.parseTransaction({ data: tx.data });

          if (decoded && decoded.name === 'reportComputeResult') {
            input = decoded.args[1]; // input is the 2nd parameter
            output = decoded.args[2]; // output is the 3rd parameter
          }
        } catch (error) {
          console.warn(`Failed to decode transaction data: ${error}`);
        }

        // Extract fee earned from RequestDisbursed event
        // RequestDisbursed(bytes32 indexed requestId, address indexed to, address indexed token, uint256 amount, uint16 redundancyCount)
        let feeEarned = '0';
        let isPenalty = false;

        // Look for RequestDisbursed event where the recipient is the agent's payment wallet
        const requestDisbursedSignature = '0xfab66afb795acabdb9d25b8483330bd32d4ac9b22e83e44ae20cffc94101a33e';
        const disbursedLog = receipt.logs.find(log =>
          log.topics[0] === requestDisbursedSignature &&
          log.topics[1].toLowerCase() === requestId.toLowerCase() &&
          log.topics[2].toLowerCase() === `0x000000000000000000000000${paymentWallet.slice(2).toLowerCase()}`
        );

        if (disbursedLog) {
          // Decode the amount from the data field (first 32 bytes)
          const amount = BigInt(disbursedLog.data.slice(0, 66));
          feeEarned = amount.toString();
          isPenalty = false;
        } else {
          // If no disbursement found, it might be a penalty
          // Check for balance decrease
          const prevBlock = event.blockNumber - 1;
          const balanceBefore = await provider.getBalance(paymentWallet, prevBlock);
          const balanceAfter = await provider.getBalance(paymentWallet, event.blockNumber);
          const balanceChange = balanceAfter - balanceBefore;

          if (balanceChange < 0n) {
            isPenalty = true;
            feeEarned = (-balanceChange).toString();
          }
        }

        return {
          requestId,
          subscriptionId,
          interval,
          blockNumber: event.blockNumber,
          timestamp: block.timestamp,
          transactionHash: event.transactionHash,
          containerId,
          redundancy,
          feeAmount,
          feeToken,
          gasFee,
          feeEarned,
          isPenalty,
          input,
          output,
        };
      })
    );

    // Filter out null entries (already sorted by block number descending)
    const validHistory = history.filter(h => h !== null) as HistoryEntry[];

    return NextResponse.json({
      agentAddress,
      paymentWallet,
      total: deliveredEvents.length,
      limit,
      offset,
      history: validHistory,
    });
  } catch (error) {
    console.error('Error fetching computing history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch computing history', details: (error as Error).message },
      { status: 500 }
    );
  }
}
