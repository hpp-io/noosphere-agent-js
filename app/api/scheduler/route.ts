import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

// This is a placeholder API for scheduler status
// In a real implementation, this would communicate with the running agent
export async function GET() {
  try {
    // Load configuration
    const config = loadConfig();

    // Return scheduler configuration and mock stats
    // In production, this would query the actual agent's scheduler service
    return NextResponse.json({
      enabled: config.scheduler.enabled,
      cronIntervalMs: config.scheduler.cronIntervalMs,
      syncPeriodMs: config.scheduler.syncPeriodMs,
      stats: {
        totalSubscriptions: 0,
        activeSubscriptions: 0,
        committedIntervals: 0,
        pendingTransactions: 0,
      },
      subscriptions: [],
      lastRun: new Date().toISOString(),
      nextRun: new Date(Date.now() + config.scheduler.cronIntervalMs).toISOString(),
    });
  } catch (error) {
    console.error('Error loading scheduler status:', error);
    return NextResponse.json(
      { error: 'Failed to load scheduler status', details: (error as Error).message },
      { status: 500 }
    );
  }
}
