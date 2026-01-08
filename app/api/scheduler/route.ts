import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { getDatabase } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Load configuration
    const config = loadConfig();

    // Read agent status from database
    let schedulerStats = {
      tracking: 0,
      active: 0,
      pendingTxs: 0,
    };

    let eventStats = {
      total: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      expired: 0,
      pending: 0,
      processing: 0,
    };

    try {
      const db = getDatabase();
      const latestStatus = db.getLatestAgentStatus();

      // Check if status is recent (within last 2 minutes)
      if (latestStatus && latestStatus.recorded_at) {
        // SQLite CURRENT_TIMESTAMP is UTC, append 'Z' to parse as UTC
        const recordedAt = new Date(latestStatus.recorded_at + 'Z').getTime();
        const now = Date.now();
        const isRecent = now - recordedAt < 120000;

        if (isRecent) {
          schedulerStats = {
            tracking: latestStatus.total_subscriptions || 0,
            active: latestStatus.active_subscriptions || 0,
            pendingTxs: latestStatus.pending_transactions || 0,
          };
        }
      }

      // Get event statistics
      eventStats = db.getEventStats();
    } catch (err) {
      // If database can't be read, use default values
      console.warn('Could not read agent status from database:', (err as Error).message);
    }

    return NextResponse.json({
      enabled: config.scheduler.enabled,
      cronIntervalMs: config.scheduler.cronIntervalMs,
      syncPeriodMs: config.scheduler.syncPeriodMs,
      scheduler: schedulerStats,
      events: eventStats,
      // Legacy fields for backward compatibility
      stats: {
        totalSubscriptions: schedulerStats.tracking,
        activeSubscriptions: schedulerStats.active,
        committedIntervals: eventStats.completed,
        pendingTransactions: schedulerStats.pendingTxs,
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
