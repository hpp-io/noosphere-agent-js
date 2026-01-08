/**
 * Computing History API (SQLite-based)
 *
 * Fast history API using SQLite database.
 * Events are saved by the agent via onComputeDelivered callback.
 */

import { NextResponse } from 'next/server';
import { getDatabase, EventStatus } from '@/lib/db';
import { loadConfig } from '@/lib/config';
import { KeystoreManager } from '@noosphere/crypto';
import * as fs from 'fs/promises';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = parseInt(searchParams.get('offset') || '0');

    // Optional filters
    const subscriptionId = searchParams.get('subscription');
    const containerId = searchParams.get('container');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const status = searchParams.get('status'); // pending, processing, completed, failed, skipped, or comma-separated

    // Load configuration for agent info
    const config = loadConfig();

    // Get agent address from keystore
    let agentAddress = '';
    try {
      const keystoreData = await fs.readFile(config.chain.wallet.keystorePath, 'utf-8');
      const keystore = await KeystoreManager.importKeystore(
        config.chain.wallet.keystorePath,
        config.secrets.keystorePassword,
        keystoreData
      );
      agentAddress = keystore.getEOAAddress();
    } catch (error) {
      console.warn('Could not load keystore for agent address:', error);
    }

    const paymentWallet = config.chain.wallet.paymentAddress;

    // Get database
    const db = getDatabase();

    // Build filters
    const filters: {
      subscriptionId?: number;
      containerId?: string;
      startTimestamp?: number;
      endTimestamp?: number;
      status?: EventStatus | EventStatus[];
    } = {};

    if (subscriptionId) {
      filters.subscriptionId = parseInt(subscriptionId);
    }

    if (containerId) {
      filters.containerId = containerId;
    }

    if (startDate) {
      filters.startTimestamp = new Date(startDate).getTime();
    }

    if (endDate) {
      filters.endTimestamp = new Date(endDate).getTime();
    }

    if (status) {
      // Support comma-separated status values
      filters.status = (status.includes(',') ? status.split(',') : status) as EventStatus | EventStatus[];
    }

    // Query database
    const result = db.getEvents(limit, offset, filters);

    // Convert database format to API format
    const history = result.data.map((event) => ({
      requestId: event.request_id,
      subscriptionId: event.subscription_id,
      interval: event.interval,
      blockNumber: event.block_number,
      timestamp: Math.floor(event.timestamp / 1000), // Convert ms to seconds
      transactionHash: event.tx_hash,
      containerId: event.container_id,
      redundancy: event.redundancy,
      feeAmount: event.fee_amount,
      feeToken: event.fee_token,
      gasFee: event.gas_fee,
      feeEarned: event.fee_earned,
      isPenalty: event.is_penalty,
      status: event.status,
      input: event.input || '',
      output: event.output || '',
    }));

    return NextResponse.json({
      agentAddress,
      paymentWallet,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      history,
    });
  } catch (error) {
    console.error('Error fetching computing history:', error);

    // If database error, provide helpful message
    if ((error as Error).message.includes('no such table')) {
      return NextResponse.json(
        {
          error: 'Database not initialized',
          details: 'Database tables not found. The agent will create them on first run.',
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch computing history', details: (error as Error).message },
      { status: 500 }
    );
  }
}
