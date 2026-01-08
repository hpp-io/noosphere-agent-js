-- Noosphere Agent - SQLite Schema
-- Version: 1.0
-- Created: 2026-01-06

-- ==================== Events ====================

CREATE TABLE IF NOT EXISTS events (
    -- Primary key
    request_id TEXT PRIMARY KEY,

    -- Request info
    subscription_id INTEGER NOT NULL,
    interval INTEGER NOT NULL,
    container_id TEXT NOT NULL,

    -- Blockchain info (from RequestStarted event)
    block_number INTEGER NOT NULL,
    timestamp BIGINT NOT NULL,

    -- Transaction info (filled after delivery)
    tx_hash TEXT UNIQUE,

    -- Configuration
    redundancy INTEGER NOT NULL,
    fee_amount TEXT NOT NULL,
    fee_token TEXT NOT NULL,
    verifier TEXT,
    wallet_address TEXT,

    -- Results (filled after delivery)
    gas_fee TEXT,
    fee_earned TEXT,
    is_penalty BOOLEAN NOT NULL DEFAULT 0,

    -- Processing status: pending, processing, completed, failed, skipped
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,

    -- Data
    input TEXT,
    output TEXT,

    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_block_number ON events(block_number);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_subscription ON events(subscription_id);
CREATE INDEX IF NOT EXISTS idx_events_container ON events(container_id);
CREATE INDEX IF NOT EXISTS idx_events_tx_hash ON events(tx_hash);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- ==================== Checkpoints ====================

CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Checkpoint data
    block_number INTEGER NOT NULL,
    block_hash TEXT,
    block_timestamp INTEGER,

    -- Event processing state
    events_processed INTEGER DEFAULT 0,
    last_request_id TEXT,

    -- Metadata
    checkpoint_type TEXT NOT NULL DEFAULT 'auto',
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    UNIQUE(block_number, checkpoint_type)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_block_number ON checkpoints(block_number DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoints_created_at ON checkpoints(created_at DESC);

-- View for latest checkpoint
CREATE VIEW IF NOT EXISTS latest_checkpoint AS
SELECT * FROM checkpoints
WHERE checkpoint_type = 'auto'
ORDER BY block_number DESC
LIMIT 1;

-- ==================== Agent Status Log ====================

CREATE TABLE IF NOT EXISTS agent_status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Status
    running BOOLEAN NOT NULL,
    address TEXT NOT NULL,

    -- Containers
    containers_running INTEGER DEFAULT 0,

    -- Scheduler stats
    total_subscriptions INTEGER DEFAULT 0,
    active_subscriptions INTEGER DEFAULT 0,
    committed_intervals INTEGER DEFAULT 0,
    pending_transactions INTEGER DEFAULT 0,

    -- System info
    uptime_seconds INTEGER,
    memory_mb INTEGER,
    cpu_percent REAL,

    -- Timestamp
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_status_recorded_at ON agent_status_log(recorded_at DESC);

-- View for latest status
CREATE VIEW IF NOT EXISTS latest_agent_status AS
SELECT * FROM agent_status_log
ORDER BY recorded_at DESC
LIMIT 1;

-- ==================== Prepare Transactions ====================
-- Tracks scheduler's prepareNextInterval transactions (gas costs)

CREATE TABLE IF NOT EXISTS prepare_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Transaction info
    tx_hash TEXT NOT NULL UNIQUE,
    block_number INTEGER NOT NULL,

    -- Subscription info
    subscription_id INTEGER NOT NULL,
    interval INTEGER NOT NULL,

    -- Gas costs
    gas_used TEXT NOT NULL,
    gas_price TEXT NOT NULL,
    gas_cost TEXT NOT NULL,

    -- Status: success, failed
    status TEXT NOT NULL DEFAULT 'success',
    error_message TEXT,

    -- Timestamp
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_prepare_tx_hash ON prepare_transactions(tx_hash);
CREATE INDEX IF NOT EXISTS idx_prepare_subscription ON prepare_transactions(subscription_id);
CREATE INDEX IF NOT EXISTS idx_prepare_created_at ON prepare_transactions(created_at DESC);

-- ==================== Metadata ====================

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==================== Initial Metadata ====================

INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '1.0');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('created_at', datetime('now'));
