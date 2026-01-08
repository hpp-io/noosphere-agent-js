/**
 * Statistics API
 *
 * Provides aggregated statistics about agent performance and earnings.
 * Uses SQLite for fast queries.
 */

import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { ethers } from 'ethers';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const hours = parseInt(searchParams.get('hours') || '24');

    const db = getDatabase();

    // Get overall stats
    const overallStats = db.getStats();

    // Get recent activity
    const recentActivity = db.getRecentActivity(hours);

    // Get stats by container
    const byContainer = db.getStatsByContainer();

    // Get stats by subscription
    const bySubscription = db.getStatsBySubscription();

    // Format response
    return NextResponse.json({
      overall: {
        totalRequests: overallStats.totalRequests,
        totalEarned: overallStats.totalEarned,
        totalEarnedEth: ethers.formatEther(overallStats.totalEarned),
        totalGas: overallStats.totalGas,
        totalGasEth: ethers.formatEther(overallStats.totalGas),
        netProfit: overallStats.netProfit,
        netProfitEth: ethers.formatEther(overallStats.netProfit),
        penaltyCount: overallStats.penaltyCount,
      },
      recent: {
        hours,
        count: recentActivity.count,
        earned: recentActivity.earned,
        earnedEth: ethers.formatEther(recentActivity.earned),
        gas: recentActivity.gas,
        gasEth: ethers.formatEther(recentActivity.gas),
      },
      byContainer: byContainer.map((c) => ({
        containerId: c.container_id,
        containerName: tryDecodeBytes32(c.container_id),
        count: c.count,
        totalEarned: c.total_earned,
        totalEarnedEth: ethers.formatEther(c.total_earned),
        totalGas: c.total_gas,
        totalGasEth: ethers.formatEther(c.total_gas),
        avgEarned: ethers.formatEther(BigInt(c.total_earned) / BigInt(c.count || 1)),
      })),
      bySubscription: bySubscription.map((s) => ({
        subscriptionId: s.subscription_id,
        count: s.count,
        totalEarned: s.total_earned,
        totalEarnedEth: ethers.formatEther(s.total_earned),
        lastTimestamp: s.last_timestamp,
        lastDate: new Date(s.last_timestamp).toISOString(),
      })),
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);

    if ((error as Error).message.includes('no such table')) {
      return NextResponse.json(
        {
          error: 'Database not initialized',
          details: 'Run "npm run migrate:sqlite" to initialize the database',
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch statistics', details: (error as Error).message },
      { status: 500 }
    );
  }
}

/**
 * Try to decode bytes32 string (container ID)
 */
function tryDecodeBytes32(bytes32: string): string {
  try {
    return ethers.decodeBytes32String(bytes32);
  } catch {
    return bytes32;
  }
}
