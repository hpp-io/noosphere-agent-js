/**
 * Database Layer - SQLite
 *
 * Provides persistent storage for:
 * - Computing history (events)
 * - Checkpoints (block tracking)
 * - Subscriptions (scheduler state)
 * - Committed intervals (deduplication)
 * - Containers & Verifiers (registry cache)
 * - Agent status log
 * - Metadata
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export type EventStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped' | 'expired';

export interface EventRecord {
  request_id: string;
  subscription_id: number;
  interval: number;
  block_number: number;
  timestamp: number;
  tx_hash?: string;
  container_id: string;
  redundancy: number;
  fee_amount: string;
  fee_token: string;
  verifier?: string;
  wallet_address?: string;
  gas_fee?: string;
  fee_earned?: string;
  is_penalty: boolean;
  status: EventStatus;
  error_message?: string;
  input?: string;
  output?: string;
  created_at?: string;
  updated_at?: string;
}

export interface RequestStartedEventInput {
  request_id: string;
  subscription_id: number;
  interval: number;
  block_number: number;
  container_id: string;
  redundancy: number;
  fee_amount: string;
  fee_token: string;
  verifier?: string;
  wallet_address?: string;
}

export interface PaginatedResult<T> {
  total: number;
  limit: number;
  offset: number;
  data: T[];
}

export interface Checkpoint {
  id?: number;
  block_number: number;
  block_hash?: string;
  block_timestamp?: number;
  events_processed?: number;
  last_request_id?: string;
  checkpoint_type?: string;
  note?: string;
  created_at?: string;
}

export interface AgentStatusLog {
  id?: number;
  running: boolean;
  address: string;
  containers_running?: number;
  total_subscriptions?: number;
  active_subscriptions?: number;
  committed_intervals?: number;
  pending_transactions?: number;
  uptime_seconds?: number;
  memory_mb?: number;
  cpu_percent?: number;
  recorded_at?: string;
}

export interface PrepareTransaction {
  id?: number;
  tx_hash: string;
  block_number: number;
  subscription_id: number;
  interval: number;
  gas_used: string;
  gas_price: string;
  gas_cost: string;
  status: 'success' | 'failed';
  error_message?: string;
  created_at?: string;
}

export class AgentDatabase {
  private db: Database.Database;
  private static instance: AgentDatabase;

  private constructor(dbPath?: string) {
    // Support NOOSPHERE_DATA_DIR environment variable for E2E testing isolation
    const dataDir = process.env.NOOSPHERE_DATA_DIR || '.noosphere';
    // If dataDir is absolute path, use it directly; otherwise join with cwd
    const defaultPath = path.isAbsolute(dataDir)
      ? path.join(dataDir, 'agent.db')
      : path.join(process.cwd(), dataDir, 'agent.db');
    const finalPath = dbPath || defaultPath;

    // Ensure directory exists
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open database
    this.db = new Database(finalPath);
    this.db.pragma('journal_mode = WAL'); // Better concurrent access

    // Initialize schema
    this.initSchema();
  }

  /**
   * Singleton pattern - get database instance
   */
  public static getInstance(dbPath?: string): AgentDatabase {
    if (!AgentDatabase.instance) {
      AgentDatabase.instance = new AgentDatabase(dbPath);
    }
    return AgentDatabase.instance;
  }

  /**
   * Initialize database schema
   */
  private initSchema(): void {
    // Load and execute schema from schema.sql file
    const schemaPath = path.join(process.cwd(), 'schema.sql');

    if (fs.existsSync(schemaPath)) {
      const schema = fs.readFileSync(schemaPath, 'utf-8');
      this.db.exec(schema);
    } else {
      console.warn('⚠️  schema.sql not found, using minimal schema');
      // Fallback minimal schema
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          request_id TEXT PRIMARY KEY,
          subscription_id INTEGER NOT NULL,
          interval INTEGER NOT NULL,
          block_number INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          tx_hash TEXT NOT NULL UNIQUE,
          container_id TEXT NOT NULL,
          redundancy INTEGER NOT NULL,
          fee_amount TEXT NOT NULL,
          fee_token TEXT NOT NULL,
          gas_fee TEXT NOT NULL,
          fee_earned TEXT NOT NULL,
          is_penalty BOOLEAN NOT NULL DEFAULT 0,
          input TEXT,
          output TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
    }
  }

  // ==================== Events ====================

  /**
   * Save RequestStarted event (initial event with pending status)
   * Returns true if saved successfully, false if already exists or failed
   */
  public saveRequestStartedEvent(event: RequestStartedEventInput): boolean {
    return this.saveRequestStartedEventWithTimestamp(event, Date.now());
  }

  /**
   * Save RequestStarted event with specific timestamp (for historical sync)
   * Returns true if saved successfully, false if already exists or failed
   */
  public saveRequestStartedEventWithTimestamp(event: RequestStartedEventInput, timestamp: number): boolean {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO events (
          request_id, subscription_id, interval, block_number,
          timestamp, container_id, redundancy,
          fee_amount, fee_token, verifier, wallet_address,
          status, is_penalty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)
      `);

      const result = stmt.run(
        event.request_id,
        event.subscription_id,
        event.interval,
        event.block_number || 0, // WebSocket events may not have block_number
        timestamp,
        event.container_id,
        event.redundancy || 1,
        event.fee_amount || '0',
        event.fee_token || '0x0000000000000000000000000000000000000000',
        event.verifier || null,
        event.wallet_address || null
      );

      return result.changes > 0;
    } catch (error) {
      const errorMessage = (error as Error).message || String(error);
      // Check if it's a duplicate key error (UNIQUE constraint)
      if (errorMessage.includes('UNIQUE constraint failed')) {
        console.warn(`  ⚠️ Event already exists: ${event.request_id.slice(0, 10)}...`);
        return false;
      }
      // Log other errors
      console.error(`  ❌ Failed to save event ${event.request_id.slice(0, 10)}...: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Update event status to processing
   */
  public updateEventToProcessing(requestId: string): void {
    this.db.prepare(`
      UPDATE events
      SET status = 'processing', updated_at = CURRENT_TIMESTAMP
      WHERE request_id = ?
    `).run(requestId);
  }

  /**
   * Update event status to skipped
   * Note: Does NOT overwrite 'completed' status to prevent race conditions
   */
  public updateEventToSkipped(requestId: string, reason: string): void {
    this.db.prepare(`
      UPDATE events
      SET status = 'skipped', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE request_id = ? AND status NOT IN ('completed')
    `).run(reason, requestId);
  }

  /**
   * Update event status to failed
   * Note: Does NOT overwrite 'completed' status to prevent race conditions
   * @param requestId - Request ID
   * @param error - Error message
   * @param txHash - Optional transaction hash (if tx was sent before failure)
   */
  public updateEventToFailed(requestId: string, error: string, txHash?: string): void {
    if (txHash) {
      this.db.prepare(`
        UPDATE events
        SET status = 'failed', error_message = ?, tx_hash = ?, updated_at = CURRENT_TIMESTAMP
        WHERE request_id = ? AND status NOT IN ('completed')
      `).run(error, txHash, requestId);
    } else {
      this.db.prepare(`
        UPDATE events
        SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE request_id = ? AND status NOT IN ('completed')
      `).run(error, requestId);
    }
  }

  /**
   * Update event status to expired
   */
  public updateEventToExpired(requestId: string, reason?: string): void {
    this.db.prepare(`
      UPDATE events
      SET status = 'expired', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE request_id = ?
    `).run(reason || 'Interval deadline passed', requestId);
  }

  /**
   * Update event to completed with delivery details
   */
  public updateEventToCompleted(
    requestId: string,
    txHash: string,
    gasUsed: string,
    feeEarned: string,
    input?: string,
    output?: string
  ): void {
    this.db.prepare(`
      UPDATE events
      SET status = 'completed',
          tx_hash = ?,
          gas_fee = ?,
          fee_earned = ?,
          input = ?,
          output = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE request_id = ?
    `).run(txHash, gasUsed, feeEarned, input || null, output || null, requestId);
  }

  /**
   * Insert or update event (legacy method for backward compatibility)
   */
  public saveEvent(event: EventRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO events (
        request_id, subscription_id, interval, block_number,
        timestamp, tx_hash, container_id, redundancy,
        fee_amount, fee_token, verifier, wallet_address,
        gas_fee, fee_earned, is_penalty, status, error_message,
        input, output
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.request_id,
      event.subscription_id,
      event.interval,
      event.block_number,
      event.timestamp,
      event.tx_hash || null,
      event.container_id,
      event.redundancy,
      event.fee_amount,
      event.fee_token,
      event.verifier || null,
      event.wallet_address || null,
      event.gas_fee || null,
      event.fee_earned || null,
      event.is_penalty ? 1 : 0,
      event.status || 'completed',
      event.error_message || null,
      event.input || null,
      event.output || null
    );
  }

  /**
   * Batch insert events (much faster)
   */
  public saveEventsBatch(events: EventRecord[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO events (
        request_id, subscription_id, interval, block_number,
        timestamp, tx_hash, container_id, redundancy,
        fee_amount, fee_token, verifier, wallet_address,
        gas_fee, fee_earned, is_penalty, status, error_message,
        input, output
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((events: EventRecord[]) => {
      for (const event of events) {
        stmt.run(
          event.request_id,
          event.subscription_id,
          event.interval,
          event.block_number,
          event.timestamp,
          event.tx_hash || null,
          event.container_id,
          event.redundancy,
          event.fee_amount,
          event.fee_token,
          event.verifier || null,
          event.wallet_address || null,
          event.gas_fee || null,
          event.fee_earned || null,
          event.is_penalty ? 1 : 0,
          event.status || 'completed',
          event.error_message || null,
          event.input || null,
          event.output || null
        );
      }
    });

    insertMany(events);
  }

  /**
   * Get events with pagination
   */
  public getEvents(
    limit: number = 50,
    offset: number = 0,
    filters?: {
      subscriptionId?: number;
      containerId?: string;
      startTimestamp?: number;
      endTimestamp?: number;
      status?: EventStatus | EventStatus[];
    }
  ): PaginatedResult<EventRecord> {
    let query = 'SELECT * FROM events WHERE 1=1';
    const params: any[] = [];

    // Apply filters
    if (filters?.subscriptionId !== undefined) {
      query += ' AND subscription_id = ?';
      params.push(filters.subscriptionId);
    }

    if (filters?.containerId) {
      query += ' AND container_id = ?';
      params.push(filters.containerId);
    }

    if (filters?.startTimestamp) {
      query += ' AND timestamp >= ?';
      params.push(filters.startTimestamp);
    }

    if (filters?.endTimestamp) {
      query += ' AND timestamp <= ?';
      params.push(filters.endTimestamp);
    }

    if (filters?.status) {
      if (Array.isArray(filters.status)) {
        const placeholders = filters.status.map(() => '?').join(', ');
        query += ` AND status IN (${placeholders})`;
        params.push(...filters.status);
      } else {
        query += ' AND status = ?';
        params.push(filters.status);
      }
    }

    // Count total
    const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as count');
    const total = (this.db.prepare(countQuery).get(...params) as { count: number }).count;

    // Get paginated results
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const data = this.db.prepare(query).all(...params) as EventRecord[];

    return {
      total,
      limit,
      offset,
      data,
    };
  }

  /**
   * Get single event by request ID
   */
  public getEvent(requestId: string): EventRecord | undefined {
    return this.db
      .prepare('SELECT * FROM events WHERE request_id = ?')
      .get(requestId) as EventRecord | undefined;
  }

  /**
   * Check if event exists
   */
  public eventExists(requestId: string): boolean {
    const result = this.db
      .prepare('SELECT 1 FROM events WHERE request_id = ? LIMIT 1')
      .get(requestId);
    return !!result;
  }

  /**
   * Check if event is already processed (completed, failed, skipped, or expired)
   * Used to prevent duplicate processing during event replay
   */
  public isEventProcessed(requestId: string): boolean {
    const result = this.db
      .prepare("SELECT status FROM events WHERE request_id = ? AND status IN ('completed', 'failed', 'skipped', 'expired') LIMIT 1")
      .get(requestId);
    return !!result;
  }

  // ==================== Statistics ====================

  /**
   * Get overall statistics
   */
  public getStats(): {
    totalRequests: number;
    totalEarned: string;
    totalGas: string;
    netProfit: string;
    penaltyCount: number;
  } {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as totalRequests,
        SUM(CAST(fee_earned AS INTEGER)) as totalEarned,
        SUM(CAST(gas_fee AS INTEGER)) as totalGas,
        SUM(CASE WHEN is_penalty = 1 THEN 1 ELSE 0 END) as penaltyCount
      FROM events
    `).get() as any;

    const totalEarned = BigInt(stats.totalEarned || 0);
    const totalGas = BigInt(stats.totalGas || 0);
    const netProfit = totalEarned - totalGas;

    return {
      totalRequests: stats.totalRequests || 0,
      totalEarned: totalEarned.toString(),
      totalGas: totalGas.toString(),
      netProfit: netProfit.toString(),
      penaltyCount: stats.penaltyCount || 0,
    };
  }

  /**
   * Get stats by container
   */
  public getStatsByContainer(): Array<{
    container_id: string;
    count: number;
    total_earned: string;
    total_gas: string;
  }> {
    return this.db.prepare(`
      SELECT
        container_id,
        COUNT(*) as count,
        SUM(CAST(fee_earned AS INTEGER)) as total_earned,
        SUM(CAST(gas_fee AS INTEGER)) as total_gas
      FROM events
      GROUP BY container_id
      ORDER BY count DESC
    `).all() as any[];
  }

  /**
   * Get stats by subscription
   */
  public getStatsBySubscription(): Array<{
    subscription_id: number;
    count: number;
    total_earned: string;
    last_timestamp: number;
  }> {
    return this.db.prepare(`
      SELECT
        subscription_id,
        COUNT(*) as count,
        SUM(CAST(fee_earned AS INTEGER)) as total_earned,
        MAX(timestamp) as last_timestamp
      FROM events
      GROUP BY subscription_id
      ORDER BY last_timestamp DESC
    `).all() as any[];
  }

  /**
   * Get recent activity (last N hours)
   */
  public getRecentActivity(hours: number = 24): {
    count: number;
    earned: string;
    gas: string;
  } {
    const cutoff = Date.now() - hours * 3600 * 1000;

    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as count,
        SUM(CAST(fee_earned AS INTEGER)) as earned,
        SUM(CAST(gas_fee AS INTEGER)) as gas
      FROM events
      WHERE timestamp >= ?
    `).get(cutoff) as any;

    return {
      count: stats.count || 0,
      earned: (stats.earned || 0).toString(),
      gas: (stats.gas || 0).toString(),
    };
  }

  // ==================== Checkpoints ====================

  /**
   * Save checkpoint
   */
  public saveCheckpoint(checkpoint: Checkpoint): void {
    this.db.prepare(`
      INSERT INTO checkpoints (
        block_number, block_hash, block_timestamp,
        events_processed, last_request_id, checkpoint_type, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(block_number, checkpoint_type) DO UPDATE SET
        block_hash = excluded.block_hash,
        block_timestamp = excluded.block_timestamp,
        events_processed = excluded.events_processed,
        last_request_id = excluded.last_request_id,
        note = excluded.note
    `).run(
      checkpoint.block_number,
      checkpoint.block_hash || null,
      checkpoint.block_timestamp || null,
      checkpoint.events_processed || 0,
      checkpoint.last_request_id || null,
      checkpoint.checkpoint_type || 'auto',
      checkpoint.note || null
    );
  }

  /**
   * Get latest checkpoint
   */
  public getLatestCheckpoint(type: string = 'auto'): Checkpoint | undefined {
    return this.db.prepare(`
      SELECT * FROM checkpoints
      WHERE checkpoint_type = ?
      ORDER BY block_number DESC
      LIMIT 1
    `).get(type) as Checkpoint | undefined;
  }

  /**
   * Get checkpoint by block number
   */
  public getCheckpoint(blockNumber: number, type: string = 'auto'): Checkpoint | undefined {
    return this.db.prepare(`
      SELECT * FROM checkpoints
      WHERE block_number = ? AND checkpoint_type = ?
    `).get(blockNumber, type) as Checkpoint | undefined;
  }

  // ==================== Agent Status Log ====================

  /**
   * Log agent status (upsert - always updates single row with id=1)
   */
  public logAgentStatus(status: AgentStatusLog): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_status_log (
        id, running, address, containers_running,
        total_subscriptions, active_subscriptions,
        committed_intervals, pending_transactions,
        uptime_seconds, memory_mb, cpu_percent,
        recorded_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      status.running ? 1 : 0,
      status.address,
      status.containers_running || 0,
      status.total_subscriptions || 0,
      status.active_subscriptions || 0,
      status.committed_intervals || 0,
      status.pending_transactions || 0,
      status.uptime_seconds || null,
      status.memory_mb || null,
      status.cpu_percent || null
    );
  }

  /**
   * Get latest agent status
   */
  public getLatestAgentStatus(): AgentStatusLog | undefined {
    return this.db.prepare(`
      SELECT * FROM agent_status_log
      ORDER BY recorded_at DESC
      LIMIT 1
    `).get() as AgentStatusLog | undefined;
  }

  /**
   * Get agent status history
   */
  public getAgentStatusHistory(hours: number = 24): AgentStatusLog[] {
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    return this.db.prepare(`
      SELECT * FROM agent_status_log
      WHERE recorded_at > ?
      ORDER BY recorded_at DESC
    `).all(cutoff) as AgentStatusLog[];
  }

  /**
   * Clean old status logs
   */
  public cleanOldStatusLogs(daysToKeep: number = 30): number {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 3600 * 1000).toISOString();
    const result = this.db.prepare(`
      DELETE FROM agent_status_log
      WHERE recorded_at < ?
    `).run(cutoff);
    return result.changes;
  }

  // ==================== Metadata ====================

  /**
   * Set metadata value
   */
  public setMetadata(key: string, value: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO metadata (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).run(key, value);
  }

  /**
   * Get metadata value
   */
  public getMetadata(key: string): string | undefined {
    const result = this.db
      .prepare('SELECT value FROM metadata WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return result?.value;
  }

  // ==================== Maintenance ====================

  /**
   * Vacuum database (optimize storage)
   */
  public vacuum(): void {
    this.db.exec('VACUUM');
  }

  /**
   * Get database size in bytes
   */
  public getSize(): number {
    const result = this.db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get() as { size: number };
    return result.size;
  }

  /**
   * Backup database to file
   */
  public async backup(backupPath: string): Promise<void> {
    await this.db.backup(backupPath);
  }

  // ==================== Committed Intervals ====================

  /**
   * Fix inconsistent event statuses on startup
   * Events with tx_hash should be 'completed', not 'skipped' or 'failed'
   * This handles race conditions from previous runs
   */
  public fixInconsistentEventStatuses(): number {
    const result = this.db.prepare(`
      UPDATE events
      SET status = 'completed', updated_at = CURRENT_TIMESTAMP
      WHERE tx_hash IS NOT NULL
        AND tx_hash != ''
        AND status NOT IN ('completed')
    `).run();

    if (result.changes > 0) {
      console.log(`  ✓ Fixed ${result.changes} events with inconsistent status (had tx_hash but not completed)`);
    }

    return result.changes;
  }

  /**
   * Get all committed interval keys (subscription:interval format)
   * Used for scheduler persistence on restart
   */
  public getCommittedIntervalKeys(): string[] {
    const rows = this.db.prepare(`
      SELECT subscription_id, interval FROM events
      WHERE status IN ('pending', 'processing', 'completed')
    `).all() as { subscription_id: number; interval: number }[];

    return rows.map(row => `${row.subscription_id}:${row.interval}`);
  }

  /**
   * Save committed interval (no-op if event already exists from RequestStarted)
   * The actual save happens in saveRequestStartedEvent
   */
  public saveCommittedInterval(key: string): void {
    // Committed intervals are already tracked via events table
    // This is a no-op since saveRequestStartedEvent handles it
    // The key format is subscription_id:interval
  }

  /**
   * Get event statistics by status
   */
  public getEventStats(): { total: number; completed: number; pending: number; processing: number; failed: number; skipped: number; expired: number } {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM events GROUP BY status
    `).all() as { status: string; count: number }[];

    const stats = {
      total: 0,
      completed: 0,
      pending: 0,
      processing: 0,
      failed: 0,
      skipped: 0,
      expired: 0,
    };

    for (const row of rows) {
      stats.total += row.count;
      if (row.status in stats) {
        (stats as any)[row.status] = row.count;
      }
    }

    return stats;
  }

  // ==================== Prepare Transactions ====================

  /**
   * Save a prepare transaction (scheduler's prepareNextInterval)
   */
  public savePrepareTransaction(tx: Omit<PrepareTransaction, 'id' | 'created_at'>): boolean {
    try {
      this.db.prepare(`
        INSERT INTO prepare_transactions (
          tx_hash, block_number, subscription_id, interval,
          gas_used, gas_price, gas_cost, status, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tx.tx_hash,
        tx.block_number,
        tx.subscription_id,
        tx.interval,
        tx.gas_used,
        tx.gas_price,
        tx.gas_cost,
        tx.status,
        tx.error_message || null
      );
      return true;
    } catch (error) {
      // Ignore duplicate tx_hash
      if ((error as Error).message.includes('UNIQUE constraint failed')) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Get prepare transactions with pagination
   */
  public getPrepareTransactions(
    limit: number = 50,
    offset: number = 0,
    subscriptionId?: number
  ): PaginatedResult<PrepareTransaction> {
    let countSql = 'SELECT COUNT(*) as total FROM prepare_transactions';
    let dataSql = `
      SELECT * FROM prepare_transactions
    `;
    const params: any[] = [];

    if (subscriptionId !== undefined) {
      countSql += ' WHERE subscription_id = ?';
      dataSql += ' WHERE subscription_id = ?';
      params.push(subscriptionId);
    }

    dataSql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

    const countResult = this.db.prepare(countSql).get(...params) as { total: number };
    const data = this.db.prepare(dataSql).all(...params, limit, offset) as PrepareTransaction[];

    return {
      total: countResult.total,
      limit,
      offset,
      data,
    };
  }

  /**
   * Get prepare transaction statistics
   */
  public getPrepareStats(): {
    totalTxs: number;
    totalGasCost: string;
    successCount: number;
    failedCount: number;
  } {
    const result = this.db.prepare(`
      SELECT
        COUNT(*) as total_txs,
        COALESCE(SUM(CAST(gas_cost AS INTEGER)), 0) as total_gas_cost,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
      FROM prepare_transactions
    `).get() as {
      total_txs: number;
      total_gas_cost: number;
      success_count: number;
      failed_count: number;
    };

    return {
      totalTxs: result.total_txs,
      totalGasCost: result.total_gas_cost.toString(),
      successCount: result.success_count,
      failedCount: result.failed_count,
    };
  }

  /**
   * Checkpoint WAL to main database file
   * This ensures all writes are persisted before shutdown
   */
  public checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /**
   * Close database connection
   * Checkpoints WAL before closing to ensure all data is persisted
   */
  public close(): void {
    this.checkpoint();
    this.db.close();
  }
}

// Export singleton getter
export function getDatabase(dbPath?: string): AgentDatabase {
  return AgentDatabase.getInstance(dbPath);
}

// Export for backward compatibility
export function initDB(dbPath?: string): AgentDatabase {
  return AgentDatabase.getInstance(dbPath);
}
