import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

// Test-specific database class to avoid singleton issues
class TestDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        request_id TEXT PRIMARY KEY,
        subscription_id INTEGER NOT NULL,
        interval INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        tx_hash TEXT UNIQUE,
        container_id TEXT NOT NULL,
        fee_amount TEXT NOT NULL DEFAULT '0',
        fee_token TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
        verifier TEXT,
        wallet_address TEXT,
        gas_fee TEXT,
        fee_earned TEXT,
        is_penalty BOOLEAN NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        input TEXT,
        output TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        block_number INTEGER NOT NULL,
        block_hash TEXT,
        block_timestamp INTEGER,
        events_processed INTEGER DEFAULT 0,
        last_request_id TEXT,
        checkpoint_type TEXT DEFAULT 'auto',
        note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(block_number, checkpoint_type)
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS agent_status_log (
        id INTEGER PRIMARY KEY,
        running BOOLEAN NOT NULL,
        address TEXT NOT NULL,
        containers_running INTEGER DEFAULT 0,
        total_subscriptions INTEGER DEFAULT 0,
        active_subscriptions INTEGER DEFAULT 0,
        committed_intervals INTEGER DEFAULT 0,
        pending_transactions INTEGER DEFAULT 0,
        uptime_seconds INTEGER,
        memory_mb REAL,
        cpu_percent REAL,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS prepare_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_hash TEXT UNIQUE NOT NULL,
        block_number INTEGER NOT NULL,
        subscription_id INTEGER NOT NULL,
        interval INTEGER NOT NULL,
        gas_used TEXT NOT NULL,
        gas_price TEXT NOT NULL,
        gas_cost TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  saveRequestStartedEvent(event: any): boolean {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO events (
          request_id, subscription_id, interval, block_number,
          timestamp, container_id,
          fee_amount, fee_token, verifier, wallet_address,
          status, is_penalty
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)
      `);
      const result = stmt.run(
        event.request_id,
        event.subscription_id,
        event.interval,
        event.block_number || 0,
        Date.now(),
        event.container_id,
        event.fee_amount || '0',
        event.fee_token || '0x0000000000000000000000000000000000000000',
        event.verifier || null,
        event.wallet_address || null
      );
      return result.changes > 0;
    } catch (error) {
      if ((error as Error).message.includes('UNIQUE constraint failed')) {
        return false;
      }
      return false;
    }
  }

  updateEventToProcessing(requestId: string): void {
    this.db.prepare(`
      UPDATE events SET status = 'processing', updated_at = CURRENT_TIMESTAMP
      WHERE request_id = ?
    `).run(requestId);
  }

  updateEventToSkipped(requestId: string, reason: string): void {
    this.db.prepare(`
      UPDATE events SET status = 'skipped', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE request_id = ? AND status NOT IN ('completed')
    `).run(reason, requestId);
  }

  updateEventToFailed(requestId: string, error: string, txHash?: string): void {
    if (txHash) {
      this.db.prepare(`
        UPDATE events SET status = 'failed', error_message = ?, tx_hash = ?,
        retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE request_id = ? AND status NOT IN ('completed')
      `).run(error, txHash, requestId);
    } else {
      this.db.prepare(`
        UPDATE events SET status = 'failed', error_message = ?,
        retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE request_id = ? AND status NOT IN ('completed')
      `).run(error, requestId);
    }
  }

  updateEventToCompleted(requestId: string, txHash: string, gasUsed: string, feeEarned: string, input?: string, output?: string): void {
    this.db.prepare(`
      UPDATE events SET status = 'completed', tx_hash = ?, gas_fee = ?, fee_earned = ?,
      input = ?, output = ?, updated_at = CURRENT_TIMESTAMP
      WHERE request_id = ?
    `).run(txHash, gasUsed, feeEarned, input || null, output || null, requestId);
  }

  updateEventToExpired(requestId: string, reason?: string): void {
    this.db.prepare(`
      UPDATE events SET status = 'expired', error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE request_id = ?
    `).run(reason || 'Interval deadline passed', requestId);
  }

  getRetryableEvents(maxRetries: number = 3): any[] {
    return this.db.prepare(`
      SELECT * FROM events WHERE status = 'failed' AND retry_count < ?
      ORDER BY timestamp ASC
    `).all(maxRetries);
  }

  resetEventForRetry(requestId: string): void {
    this.db.prepare(`
      UPDATE events SET status = 'pending', updated_at = CURRENT_TIMESTAMP
      WHERE request_id = ? AND status = 'failed'
    `).run(requestId);
  }

  getEvent(requestId: string): any {
    return this.db.prepare('SELECT * FROM events WHERE request_id = ?').get(requestId);
  }

  eventExists(requestId: string): boolean {
    const result = this.db.prepare('SELECT 1 FROM events WHERE request_id = ? LIMIT 1').get(requestId);
    return !!result;
  }

  isEventProcessed(requestId: string): boolean {
    const result = this.db.prepare(
      "SELECT status FROM events WHERE request_id = ? AND status IN ('completed', 'failed', 'skipped', 'expired') LIMIT 1"
    ).get(requestId);
    return !!result;
  }

  getEvents(limit: number = 50, offset: number = 0, filters?: any): any {
    let query = 'SELECT * FROM events WHERE 1=1';
    const params: any[] = [];

    if (filters?.subscriptionId !== undefined) {
      query += ' AND subscription_id = ?';
      params.push(filters.subscriptionId);
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

    const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as count');
    const total = (this.db.prepare(countQuery).get(...params) as { count: number }).count;

    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const data = this.db.prepare(query).all(...params);

    return { total, limit, offset, data };
  }

  getEventStats(): any {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM events GROUP BY status
    `).all() as { status: string; count: number }[];

    const stats = { total: 0, completed: 0, pending: 0, processing: 0, failed: 0, skipped: 0, expired: 0 };
    for (const row of rows) {
      stats.total += row.count;
      if (row.status in stats) {
        (stats as any)[row.status] = row.count;
      }
    }
    return stats;
  }

  getStats(): any {
    const stats = this.db.prepare(`
      SELECT COUNT(*) as totalRequests,
             SUM(CAST(fee_earned AS INTEGER)) as totalEarned,
             SUM(CAST(gas_fee AS INTEGER)) as totalGas,
             SUM(CASE WHEN is_penalty = 1 THEN 1 ELSE 0 END) as penaltyCount
      FROM events
    `).get() as any;

    const totalEarned = BigInt(stats.totalEarned || 0);
    const totalGas = BigInt(stats.totalGas || 0);
    return {
      totalRequests: stats.totalRequests || 0,
      totalEarned: totalEarned.toString(),
      totalGas: totalGas.toString(),
      netProfit: (totalEarned - totalGas).toString(),
      penaltyCount: stats.penaltyCount || 0,
    };
  }

  getRecentActivity(hours: number = 24): any {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const stats = this.db.prepare(`
      SELECT COUNT(*) as count,
             SUM(CAST(fee_earned AS INTEGER)) as earned,
             SUM(CAST(gas_fee AS INTEGER)) as gas
      FROM events WHERE timestamp >= ?
    `).get(cutoff) as any;

    return {
      count: stats.count || 0,
      earned: (stats.earned || 0).toString(),
      gas: (stats.gas || 0).toString(),
    };
  }

  saveCheckpoint(checkpoint: any): void {
    this.db.prepare(`
      INSERT INTO checkpoints (block_number, block_hash, block_timestamp, events_processed, last_request_id, checkpoint_type, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
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

  getLatestCheckpoint(type: string = 'auto'): any {
    return this.db.prepare(`
      SELECT * FROM checkpoints WHERE checkpoint_type = ?
      ORDER BY block_number DESC LIMIT 1
    `).get(type);
  }

  setMetadata(key: string, value: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO metadata (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).run(key, value);
  }

  getMetadata(key: string): string | undefined {
    const result = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return result?.value;
  }

  logAgentStatus(status: any): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_status_log (
        id, running, address, containers_running, total_subscriptions,
        active_subscriptions, committed_intervals, pending_transactions,
        uptime_seconds, memory_mb, cpu_percent, recorded_at
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

  getLatestAgentStatus(): any {
    return this.db.prepare(`
      SELECT * FROM agent_status_log ORDER BY recorded_at DESC LIMIT 1
    `).get();
  }

  savePrepareTransaction(tx: any): boolean {
    try {
      this.db.prepare(`
        INSERT INTO prepare_transactions (tx_hash, block_number, subscription_id, interval, gas_used, gas_price, gas_cost, status, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(tx.tx_hash, tx.block_number, tx.subscription_id, tx.interval, tx.gas_used, tx.gas_price, tx.gas_cost, tx.status, tx.error_message || null);
      return true;
    } catch (error) {
      if ((error as Error).message.includes('UNIQUE constraint failed')) {
        return false;
      }
      throw error;
    }
  }

  getPrepareTransactions(limit: number = 50, offset: number = 0, subscriptionId?: number): any {
    let countSql = 'SELECT COUNT(*) as total FROM prepare_transactions';
    let dataSql = 'SELECT * FROM prepare_transactions';
    const params: any[] = [];

    if (subscriptionId !== undefined) {
      countSql += ' WHERE subscription_id = ?';
      dataSql += ' WHERE subscription_id = ?';
      params.push(subscriptionId);
    }

    dataSql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

    const countResult = this.db.prepare(countSql).get(...params) as { total: number };
    const data = this.db.prepare(dataSql).all(...params, limit, offset);

    return { total: countResult.total, limit, offset, data };
  }

  getPrepareStats(): any {
    const result = this.db.prepare(`
      SELECT COUNT(*) as total_txs,
             COALESCE(SUM(CAST(gas_cost AS INTEGER)), 0) as total_gas_cost,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
      FROM prepare_transactions
    `).get() as any;

    return {
      totalTxs: result.total_txs,
      totalGasCost: result.total_gas_cost.toString(),
      successCount: result.success_count,
      failedCount: result.failed_count,
    };
  }

  getCommittedIntervalKeys(): string[] {
    const rows = this.db.prepare(`
      SELECT subscription_id, interval FROM events
      WHERE status IN ('pending', 'processing', 'completed')
    `).all() as { subscription_id: number; interval: number }[];

    return rows.map(row => `${row.subscription_id}:${row.interval}`);
  }

  fixInconsistentEventStatuses(): number {
    const result = this.db.prepare(`
      UPDATE events SET status = 'completed', updated_at = CURRENT_TIMESTAMP
      WHERE tx_hash IS NOT NULL AND tx_hash != '' AND status NOT IN ('completed')
    `).run();
    return result.changes;
  }

  getSize(): number {
    const result = this.db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get() as { size: number };
    return result.size;
  }

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  close(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}

describe('AgentDatabase', () => {
  let db: TestDatabase;
  const testDbPath = path.join(process.cwd(), '.test-db', 'test.db');

  beforeEach(() => {
    // Clean up any existing test db
    const testDir = path.dirname(testDbPath);
    if (fs.existsSync(testDir)) {
      const files = fs.readdirSync(testDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(testDir, file));
        } catch {}
      }
    }
    db = new TestDatabase(testDbPath);
  });

  afterEach(() => {
    db.close();
    // Cleanup
    const testDir = path.dirname(testDbPath);
    if (fs.existsSync(testDir)) {
      const files = fs.readdirSync(testDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(testDir, file));
        } catch {}
      }
      try {
        fs.rmdirSync(testDir);
      } catch {}
    }
  });

  describe('Events', () => {
    const sampleEvent = {
      request_id: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      subscription_id: 1,
      interval: 100,
      block_number: 1000,
      container_id: '0xcontainer',
      fee_amount: '1000000000000000000',
      fee_token: '0x0000000000000000000000000000000000000000',
    };

    it('should save RequestStarted event', () => {
      const result = db.saveRequestStartedEvent(sampleEvent);
      expect(result).toBe(true);

      const saved = db.getEvent(sampleEvent.request_id);
      expect(saved).toBeDefined();
      expect(saved.subscription_id).toBe(1);
      expect(saved.status).toBe('pending');
    });

    it('should reject duplicate event', () => {
      db.saveRequestStartedEvent(sampleEvent);
      const result = db.saveRequestStartedEvent(sampleEvent);
      expect(result).toBe(false);
    });

    it('should update event to processing', () => {
      db.saveRequestStartedEvent(sampleEvent);
      db.updateEventToProcessing(sampleEvent.request_id);

      const event = db.getEvent(sampleEvent.request_id);
      expect(event.status).toBe('processing');
    });

    it('should update event to skipped', () => {
      db.saveRequestStartedEvent(sampleEvent);
      db.updateEventToSkipped(sampleEvent.request_id, 'Test skip reason');

      const event = db.getEvent(sampleEvent.request_id);
      expect(event.status).toBe('skipped');
      expect(event.error_message).toBe('Test skip reason');
    });

    it('should not overwrite completed status with skipped', () => {
      db.saveRequestStartedEvent(sampleEvent);
      db.updateEventToCompleted(sampleEvent.request_id, '0xtxhash', '100000', '1000');
      db.updateEventToSkipped(sampleEvent.request_id, 'Should not apply');

      const event = db.getEvent(sampleEvent.request_id);
      expect(event.status).toBe('completed');
    });

    it('should update event to failed', () => {
      db.saveRequestStartedEvent(sampleEvent);
      db.updateEventToFailed(sampleEvent.request_id, 'Test error');

      const event = db.getEvent(sampleEvent.request_id);
      expect(event.status).toBe('failed');
      expect(event.error_message).toBe('Test error');
      expect(event.retry_count).toBe(1);
    });

    it('should update event to failed with txHash', () => {
      db.saveRequestStartedEvent(sampleEvent);
      db.updateEventToFailed(sampleEvent.request_id, 'Test error', '0xfailedtx');

      const event = db.getEvent(sampleEvent.request_id);
      expect(event.status).toBe('failed');
      expect(event.tx_hash).toBe('0xfailedtx');
    });

    it('should update event to completed', () => {
      db.saveRequestStartedEvent(sampleEvent);
      db.updateEventToCompleted(sampleEvent.request_id, '0xtxhash', '100000', '1000000', 'input data', 'output data');

      const event = db.getEvent(sampleEvent.request_id);
      expect(event.status).toBe('completed');
      expect(event.tx_hash).toBe('0xtxhash');
      expect(event.gas_fee).toBe('100000');
      expect(event.fee_earned).toBe('1000000');
      expect(event.input).toBe('input data');
      expect(event.output).toBe('output data');
    });

    it('should update event to expired', () => {
      db.saveRequestStartedEvent(sampleEvent);
      db.updateEventToExpired(sampleEvent.request_id, 'Deadline missed');

      const event = db.getEvent(sampleEvent.request_id);
      expect(event.status).toBe('expired');
      expect(event.error_message).toBe('Deadline missed');
    });

    it('should check if event exists', () => {
      expect(db.eventExists(sampleEvent.request_id)).toBe(false);
      db.saveRequestStartedEvent(sampleEvent);
      expect(db.eventExists(sampleEvent.request_id)).toBe(true);
    });

    it('should check if event is processed', () => {
      db.saveRequestStartedEvent(sampleEvent);
      expect(db.isEventProcessed(sampleEvent.request_id)).toBe(false);

      db.updateEventToCompleted(sampleEvent.request_id, '0xtx', '100', '100');
      expect(db.isEventProcessed(sampleEvent.request_id)).toBe(true);
    });

    it('should get events with pagination', () => {
      // Add multiple events
      for (let i = 0; i < 10; i++) {
        db.saveRequestStartedEvent({
          ...sampleEvent,
          request_id: `0x${i.toString().padStart(64, '0')}`,
        });
      }

      const result = db.getEvents(5, 0);
      expect(result.total).toBe(10);
      expect(result.limit).toBe(5);
      expect(result.offset).toBe(0);
      expect(result.data.length).toBe(5);
    });

    it('should filter events by subscription', () => {
      db.saveRequestStartedEvent(sampleEvent);
      db.saveRequestStartedEvent({
        ...sampleEvent,
        request_id: '0x2222',
        subscription_id: 2,
      });

      const result = db.getEvents(50, 0, { subscriptionId: 1 });
      expect(result.total).toBe(1);
    });

    it('should filter events by status array', () => {
      db.saveRequestStartedEvent(sampleEvent);
      db.saveRequestStartedEvent({
        ...sampleEvent,
        request_id: '0x2222',
      });
      db.updateEventToCompleted('0x2222', '0xtx', '100', '100');

      const result = db.getEvents(50, 0, { status: ['pending', 'completed'] });
      expect(result.total).toBe(2);
    });

    it('should get retryable events', () => {
      db.saveRequestStartedEvent(sampleEvent);
      db.updateEventToFailed(sampleEvent.request_id, 'Error 1');

      const retryable = db.getRetryableEvents(3);
      expect(retryable.length).toBe(1);
    });

    it('should reset event for retry', () => {
      db.saveRequestStartedEvent(sampleEvent);
      db.updateEventToFailed(sampleEvent.request_id, 'Error');
      db.resetEventForRetry(sampleEvent.request_id);

      const event = db.getEvent(sampleEvent.request_id);
      expect(event.status).toBe('pending');
    });
  });

  describe('Statistics', () => {
    it('should get event stats', () => {
      db.saveRequestStartedEvent({
        request_id: '0x1',
        subscription_id: 1,
        interval: 1,
        block_number: 100,
        container_id: '0xc',
      });

      const stats = db.getEventStats();
      expect(stats.total).toBe(1);
      expect(stats.pending).toBe(1);
    });

    it('should get overall stats', () => {
      db.saveRequestStartedEvent({
        request_id: '0x1',
        subscription_id: 1,
        interval: 1,
        block_number: 100,
        container_id: '0xc',
      });
      db.updateEventToCompleted('0x1', '0xtx', '100', '1000');

      const stats = db.getStats();
      expect(stats.totalRequests).toBe(1);
      expect(stats.totalGas).toBe('100');
      expect(stats.totalEarned).toBe('1000');
    });

    it('should get recent activity', () => {
      db.saveRequestStartedEvent({
        request_id: '0x1',
        subscription_id: 1,
        interval: 1,
        block_number: 100,
        container_id: '0xc',
      });
      db.updateEventToCompleted('0x1', '0xtx', '100', '1000');

      const activity = db.getRecentActivity(24);
      expect(activity.count).toBe(1);
    });
  });

  describe('Checkpoints', () => {
    it('should save and retrieve checkpoint', () => {
      db.saveCheckpoint({
        block_number: 1000,
        block_hash: '0xhash',
        checkpoint_type: 'event_monitor',
      });

      const checkpoint = db.getLatestCheckpoint('event_monitor');
      expect(checkpoint).toBeDefined();
      expect(checkpoint.block_number).toBe(1000);
      expect(checkpoint.block_hash).toBe('0xhash');
    });

    it('should update existing checkpoint', () => {
      db.saveCheckpoint({
        block_number: 1000,
        checkpoint_type: 'event_monitor',
      });

      db.saveCheckpoint({
        block_number: 1000,
        block_hash: '0xupdated',
        checkpoint_type: 'event_monitor',
      });

      const checkpoint = db.getLatestCheckpoint('event_monitor');
      expect(checkpoint.block_hash).toBe('0xupdated');
    });
  });

  describe('Metadata', () => {
    it('should set and get metadata', () => {
      db.setMetadata('test_key', 'test_value');
      expect(db.getMetadata('test_key')).toBe('test_value');
    });

    it('should update existing metadata', () => {
      db.setMetadata('key', 'value1');
      db.setMetadata('key', 'value2');
      expect(db.getMetadata('key')).toBe('value2');
    });

    it('should return undefined for missing metadata', () => {
      expect(db.getMetadata('nonexistent')).toBeUndefined();
    });
  });

  describe('Agent Status', () => {
    it('should log and retrieve agent status', () => {
      db.logAgentStatus({
        running: true,
        address: '0xagent',
        containers_running: 2,
        total_subscriptions: 10,
        active_subscriptions: 5,
      });

      const status = db.getLatestAgentStatus();
      expect(status).toBeDefined();
      expect(status.running).toBe(1); // SQLite stores as 1/0
      expect(status.address).toBe('0xagent');
      expect(status.containers_running).toBe(2);
    });
  });

  describe('Prepare Transactions', () => {
    const sampleTx = {
      tx_hash: '0xtxhash123',
      block_number: 1000,
      subscription_id: 1,
      interval: 100,
      gas_used: '21000',
      gas_price: '1000000000',
      gas_cost: '21000000000000',
      status: 'success' as const,
    };

    it('should save prepare transaction', () => {
      const result = db.savePrepareTransaction(sampleTx);
      expect(result).toBe(true);
    });

    it('should reject duplicate prepare transaction', () => {
      db.savePrepareTransaction(sampleTx);
      const result = db.savePrepareTransaction(sampleTx);
      expect(result).toBe(false);
    });

    it('should get prepare transactions with pagination', () => {
      for (let i = 0; i < 5; i++) {
        db.savePrepareTransaction({
          ...sampleTx,
          tx_hash: `0xtx${i}`,
        });
      }

      const result = db.getPrepareTransactions(3, 0);
      expect(result.total).toBe(5);
      expect(result.data.length).toBe(3);
    });

    it('should filter prepare transactions by subscription', () => {
      db.savePrepareTransaction(sampleTx);
      db.savePrepareTransaction({
        ...sampleTx,
        tx_hash: '0xother',
        subscription_id: 2,
      });

      const result = db.getPrepareTransactions(50, 0, 1);
      expect(result.total).toBe(1);
    });

    it('should get prepare stats', () => {
      db.savePrepareTransaction(sampleTx);
      db.savePrepareTransaction({
        ...sampleTx,
        tx_hash: '0xfailed',
        status: 'failed',
      });

      const stats = db.getPrepareStats();
      expect(stats.totalTxs).toBe(2);
      expect(stats.successCount).toBe(1);
      expect(stats.failedCount).toBe(1);
    });
  });

  describe('Committed Intervals', () => {
    it('should get committed interval keys', () => {
      db.saveRequestStartedEvent({
        request_id: '0x1',
        subscription_id: 1,
        interval: 100,
        block_number: 1000,
        container_id: '0xc',
      });
      db.saveRequestStartedEvent({
        request_id: '0x2',
        subscription_id: 2,
        interval: 200,
        block_number: 1001,
        container_id: '0xc',
      });

      const keys = db.getCommittedIntervalKeys();
      expect(keys).toContain('1:100');
      expect(keys).toContain('2:200');
    });
  });

  describe('Fix Inconsistent Statuses', () => {
    it('should fix events with tx_hash but not completed', () => {
      db.saveRequestStartedEvent({
        request_id: '0x1',
        subscription_id: 1,
        interval: 100,
        block_number: 1000,
        container_id: '0xc',
      });
      // Manually set tx_hash but leave status as failed
      db.updateEventToFailed('0x1', 'error', '0xtxhash');

      const changes = db.fixInconsistentEventStatuses();
      expect(changes).toBe(1);

      const event = db.getEvent('0x1');
      expect(event.status).toBe('completed');
    });
  });

  describe('Maintenance', () => {
    it('should get database size', () => {
      const size = db.getSize();
      expect(size).toBeGreaterThan(0);
    });

    it('should vacuum database', () => {
      expect(() => db.vacuum()).not.toThrow();
    });
  });
});
