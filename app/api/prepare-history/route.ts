/**
 * Prepare History API
 *
 * Returns history of scheduler's prepareNextInterval transactions
 * These are the gas costs incurred by the scheduler for scheduled subscriptions.
 */

import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { ethers } from 'ethers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = parseInt(searchParams.get('offset') || '0');
    const subscriptionId = searchParams.get('subscriptionId');

    const db = getDatabase();

    // Get prepare transactions
    const result = db.getPrepareTransactions(
      limit,
      offset,
      subscriptionId ? parseInt(subscriptionId) : undefined
    );

    // Get statistics
    const stats = db.getPrepareStats();

    // Format response
    return NextResponse.json({
      stats: {
        totalTxs: stats.totalTxs,
        totalGasCost: stats.totalGasCost,
        totalGasCostEth: ethers.formatEther(stats.totalGasCost),
        successCount: stats.successCount,
        failedCount: stats.failedCount,
      },
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        hasMore: result.offset + result.data.length < result.total,
      },
      transactions: result.data.map((tx) => ({
        id: tx.id,
        txHash: tx.tx_hash,
        blockNumber: tx.block_number,
        subscriptionId: tx.subscription_id,
        interval: tx.interval,
        gasUsed: tx.gas_used,
        gasPrice: tx.gas_price,
        gasCost: tx.gas_cost,
        gasCostEth: ethers.formatEther(tx.gas_cost),
        status: tx.status,
        errorMessage: tx.error_message,
        createdAt: tx.created_at,
      })),
    });
  } catch (error) {
    console.error('Error fetching prepare history:', error);

    if ((error as Error).message.includes('no such table')) {
      return NextResponse.json(
        {
          error: 'Database not initialized',
          details: 'The prepare_transactions table does not exist. Restart the agent to initialize.',
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch prepare history', details: (error as Error).message },
      { status: 500 }
    );
  }
}
