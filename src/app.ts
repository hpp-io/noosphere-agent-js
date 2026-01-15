import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { JsonRpcProvider } from 'ethers';
import { ethers } from 'ethers';
import { RegistryManager, KeystoreManager } from '@noosphere/agent-core';
import { getAgentManager } from './services/agent-manager';
import { getDatabase } from '../lib/db';
import { loadConfig } from '../lib/config';
import { logger } from '../lib/logger';

// Global singleton instances to avoid repeated loading
let cachedRegistry: RegistryManager | null = null;
let cachedKeystore: KeystoreManager | null = null;
let cachedEoaAddress: string | null = null;

async function getGlobalRegistry(): Promise<RegistryManager> {
  if (!cachedRegistry) {
    cachedRegistry = new RegistryManager({ autoSync: false, cacheTTL: 3600000 });
    await cachedRegistry.load();
  }
  return cachedRegistry;
}

async function getGlobalKeystore(): Promise<{ keystore: KeystoreManager; eoaAddress: string }> {
  if (!cachedKeystore || !cachedEoaAddress) {
    const config = loadConfig();
    cachedKeystore = new KeystoreManager(
      config.chain.wallet.keystorePath,
      config.secrets.keystorePassword,
    );
    await cachedKeystore.load();
    cachedEoaAddress = cachedKeystore.getEOAAddress();
  }
  return { keystore: cachedKeystore, eoaAddress: cachedEoaAddress };
}

const app = express();
const httpServer = createServer(app);

// CORS configuration - allow only same hostname (different port)
const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (curl, server-to-server, etc.)
    if (!origin) {
      callback(null, true);
      return;
    }

    try {
      const originUrl = new URL(origin);
      const originHostname = originUrl.hostname;

      // Allow localhost variations
      if (originHostname === 'localhost' || originHostname === '127.0.0.1') {
        callback(null, true);
        return;
      }

      // This will be checked against the request's Host header in the middleware
      // For now, store the origin hostname to validate later
      callback(null, true);
    } catch {
      callback(null, false);
    }
  },
  credentials: true,
};

// Additional middleware to validate origin matches Host header
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) {
    next();
    return;
  }

  try {
    const originUrl = new URL(origin);
    const originHostname = originUrl.hostname;
    const hostHeader = req.headers.host?.split(':')[0] || '';

    // Allow if origin hostname matches Host header hostname
    if (originHostname === hostHeader ||
        originHostname === 'localhost' ||
        originHostname === '127.0.0.1') {
      next();
      return;
    }

    // Block mismatched origins
    res.status(403).json({ error: 'CORS not allowed' });
  } catch {
    res.status(403).json({ error: 'Invalid origin' });
  }
});

// WebSocket server
const io = new SocketIOServer(httpServer, {
  cors: corsOptions,
});

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Helper to serialize BigInt for JSON/WebSocket
function serializeForJson(obj: any): any {
  return JSON.parse(JSON.stringify(obj, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  ));
}

// ============================================================================
// Health & Status APIs
// ============================================================================

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Agent wallet status (replaces /api/agent/status)
app.get('/api/agent/status', async (_req, res) => {
  try {
    const config = loadConfig();
    const provider = new JsonRpcProvider(config.chain.rpcUrl);

    const { eoaAddress } = await getGlobalKeystore();
    const balance = await provider.getBalance(eoaAddress);
    const balanceInGwei = Number(balance) / 1e9;

    const paymentWalletAddress = config.chain.wallet.paymentAddress;
    const paymentWalletBalance = await provider.getBalance(paymentWalletAddress);
    const paymentWalletBalanceInGwei = Number(paymentWalletBalance) / 1e9;

    res.json({
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
    res.status(500).json({ error: (error as Error).message });
  }
});

// ============================================================================
// Agents APIs (multi-agent management)
// ============================================================================

app.get('/api/agents', (_req, res) => {
  try {
    const manager = getAgentManager();
    res.json(manager.getStatus());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/agents/:id', (req, res) => {
  try {
    const manager = getAgentManager();
    const agent = manager.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent.getStatus());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/agents', async (req, res) => {
  try {
    const { id, name, configPath, keystorePassword } = req.body;
    if (!id || !configPath || !keystorePassword) {
      return res.status(400).json({ error: 'id, configPath, and keystorePassword required' });
    }
    const manager = getAgentManager();
    const agent = await manager.createAgent({ id, name, configPath, keystorePassword });
    res.status(201).json(agent.getStatus());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.delete('/api/agents/:id', async (req, res) => {
  try {
    const manager = getAgentManager();
    await manager.stopAgent(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// ============================================================================
// Scheduler API
// ============================================================================

app.get('/api/scheduler', (_req, res) => {
  try {
    const config = loadConfig();
    const db = getDatabase();

    // Get scheduler stats from running agent (live data)
    let schedulerStats = { tracking: 0, active: 0, pendingTxs: 0 };
    try {
      const manager = getAgentManager();
      const agents = manager.getStatus();
      if (agents.runningAgents > 0) {
        const agentId = agents.agents[0]?.id;
        if (agentId) {
          const agent = manager.getAgent(agentId);
          const status = agent?.getStatus();
          if (status?.scheduler) {
            schedulerStats = {
              tracking: status.scheduler.totalSubscriptions || 0,
              active: status.scheduler.activeSubscriptions || 0,
              pendingTxs: status.scheduler.pendingTransactions || 0,
            };
          }
        }
      }
    } catch {
      // Fall back to DB if agent manager not available
      const latestStatus = db.getLatestAgentStatus();
      if (latestStatus?.recorded_at) {
        const recordedAt = new Date(latestStatus.recorded_at + 'Z').getTime();
        const isRecent = Date.now() - recordedAt < 120000;
        if (isRecent) {
          schedulerStats = {
            tracking: latestStatus.total_subscriptions || 0,
            active: latestStatus.active_subscriptions || 0,
            pendingTxs: latestStatus.pending_transactions || 0,
          };
        }
      }
    }

    const eventStats = db.getEventStats();

    res.json({
      enabled: config.scheduler?.enabled ?? true,
      cronIntervalMs: config.scheduler?.cronIntervalMs ?? 60000,
      syncPeriodMs: config.scheduler?.syncPeriodMs ?? 3000,
      scheduler: schedulerStats,
      events: eventStats,
      stats: {
        totalSubscriptions: schedulerStats.tracking,
        activeSubscriptions: schedulerStats.active,
        committedIntervals: eventStats.completed,
        pendingTransactions: schedulerStats.pendingTxs,
      },
      subscriptions: [],
      lastRun: new Date().toISOString(),
      nextRun: new Date(Date.now() + (config.scheduler?.cronIntervalMs ?? 60000)).toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// ============================================================================
// Containers API
// ============================================================================

app.get('/api/containers', async (_req, res) => {
  try {
    const config = loadConfig();
    const registry = await getGlobalRegistry();

    const stats = registry.getStats();
    const registryContainers = registry.listContainers();

    const configContainers = config.containers?.map((c: any) => {
      const tags = ['local', 'compute'];
      const name = c.name || c.id.slice(0, 10);
      if (name.includes('llm')) tags.push('llm', 'ai');
      if (name.includes('hello-world')) tags.push('example', 'demo');
      return {
        id: c.id, name, imageName: c.image, verified: false,
        tags, description: `Container: ${name}`, requirements: {}, payments: {},
      };
    }) || [];

    const containerMap = new Map();
    registryContainers.forEach((c: any) => containerMap.set(c.id, {
      id: c.id, name: c.name, imageName: c.imageName, verified: c.verified,
      tags: c.tags, description: c.description, requirements: c.requirements, payments: c.payments,
    }));
    configContainers.forEach((c: any) => containerMap.set(c.id, c));

    const allContainers = Array.from(containerMap.values());

    res.json({
      stats: { ...stats, totalContainers: allContainers.length, activeContainers: allContainers.length },
      containers: allContainers,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// ============================================================================
// Verifiers API
// ============================================================================

app.get('/api/verifiers', async (_req, res) => {
  try {
    const config = loadConfig();
    const registry = await getGlobalRegistry();

    const registryVerifiers = registry.listVerifiers();
    const configVerifiers = config.verifiers?.map((v: any) => ({
      id: v.id, name: v.name, verifierAddress: v.address, requiresProof: v.requiresProof,
      proofService: v.proofService ? {
        imageName: v.proofService.image, port: v.proofService.port,
        command: v.proofService.command, env: v.proofService.env,
      } : undefined,
      verified: v.verified, description: v.description, payments: {},
    })) || [];

    const verifierMap = new Map();
    registryVerifiers.forEach((v: any) => verifierMap.set(v.id, {
      id: v.id, name: v.name, verifierAddress: v.verifierAddress,
      requiresProof: v.requiresProof, proofService: v.proofService,
      verified: v.verified, description: v.description, payments: v.payments,
    }));
    configVerifiers.forEach((v: any) => verifierMap.set(v.id, v));

    res.json({ verifiers: Array.from(verifierMap.values()) });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// ============================================================================
// History API
// ============================================================================

app.get('/api/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const subscriptionId = req.query.subscription as string;
    const containerId = req.query.container as string;
    const status = req.query.status as string;

    const config = loadConfig();
    let agentAddress = '';

    try {
      const { eoaAddress } = await getGlobalKeystore();
      agentAddress = eoaAddress;
    } catch {}

    const db = getDatabase();
    const filters: any = {};
    if (subscriptionId) filters.subscriptionId = parseInt(subscriptionId);
    if (containerId) filters.containerId = containerId;
    if (status) filters.status = status.includes(',') ? status.split(',') : status;

    const result = db.getEvents(limit, offset, filters);

    const history = result.data.map((event: any) => ({
      requestId: event.request_id,
      subscriptionId: event.subscription_id,
      interval: event.interval,
      blockNumber: event.block_number,
      timestamp: Math.floor(event.timestamp / 1000),
      transactionHash: event.tx_hash,
      containerId: event.container_id,
      redundancy: event.redundancy,
      feeAmount: event.fee_amount,
      feeToken: event.fee_token,
      gasFee: event.gas_fee,
      feeEarned: event.fee_earned,
      isPenalty: event.is_penalty,
      status: event.status,
      errorMessage: event.error_message,
      input: event.input || '',
      output: event.output || '',
    }));

    res.json({
      agentAddress,
      paymentWallet: config.chain.wallet.paymentAddress,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      history,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// ============================================================================
// Prepare History API
// ============================================================================

app.get('/api/prepare-history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const subscriptionId = req.query.subscriptionId as string;

    const db = getDatabase();
    const result = db.getPrepareTransactions(limit, offset, subscriptionId ? parseInt(subscriptionId) : undefined);
    const stats = db.getPrepareStats();

    res.json({
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
      transactions: result.data.map((tx: any) => ({
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
    res.status(500).json({ error: (error as Error).message });
  }
});

// ============================================================================
// Stats API
// ============================================================================

app.get('/api/stats', (_req, res) => {
  try {
    const db = getDatabase();
    res.json(db.getEventStats());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// ============================================================================
// WebSocket handlers
// ============================================================================

io.on('connection', (socket) => {
  logger.info(`WebSocket connected: ${socket.id}`);

  socket.on('subscribeAgent', (agentId: string) => {
    socket.join(`agent-${agentId}`);
  });

  socket.on('unsubscribeAgent', (agentId: string) => {
    socket.leave(`agent-${agentId}`);
  });

  socket.on('disconnect', () => {
    logger.info(`WebSocket disconnected: ${socket.id}`);
  });
});

// ============================================================================
// Start server
// ============================================================================

async function start() {
  const port = parseInt(process.env.EXPRESS_PORT || '4000');

  // Configure file logging if LOG_DIR is set
  const logDir = process.env.LOG_DIR || process.env.NOOSPHERE_LOG_DIR;
  if (logDir) {
    logger.configure({
      logDir,
      maxFileSize: parseInt(process.env.LOG_MAX_SIZE || '10485760'), // 10MB default
      maxFiles: parseInt(process.env.LOG_MAX_FILES || '5'),
    });
  }

  try {
    const manager = getAgentManager();

    // Forward events to WebSocket (serialize BigInt to string)
    manager.on('requestStarted', (data) => {
      const serialized = serializeForJson(data);
      io.to(`agent-${data.agentId}`).emit('requestStarted', serialized);
      io.emit('requestStarted', serialized);
    });
    manager.on('computeDelivered', (data) => {
      const serialized = serializeForJson(data);
      io.to(`agent-${data.agentId}`).emit('computeDelivered', serialized);
      io.emit('computeDelivered', serialized);
    });
    manager.on('agentStarted', (data) => io.emit('agentStarted', serializeForJson(data)));
    manager.on('agentStopped', (data) => io.emit('agentStopped', serializeForJson(data)));

    await manager.startFromConfig();

    httpServer.listen(port, () => {
      logger.info(`Express server running on http://localhost:${port}`);
      logger.info('WebSocket ready');
    });

    // Status logging
    setInterval(() => {
      const status = manager.getStatus();
      const db = getDatabase();
      const eventStats = db.getEventStats();
      console.log(`\n📊 [${new Date().toISOString()}] Agents: ${status.runningAgents}/${status.totalAgents}, Events: ${eventStats.total} (✓${eventStats.completed})`);
    }, 30000);

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down...`);
      await manager.shutdown();
      // Checkpoint and close database to ensure WAL is flushed
      const db = getDatabase();
      db.close();
      logger.info('Database closed');
      logger.close(); // Close log file stream
      httpServer.close();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    logger.error(`Failed to start: ${(error as Error).message}`);
    process.exit(1);
  }
}

// Export for testing
export { app, httpServer, io, start };

// Only start if this file is run directly (not imported)
const isMainModule = typeof require !== 'undefined' && require.main === module;
if (isMainModule) {
  start();
}
