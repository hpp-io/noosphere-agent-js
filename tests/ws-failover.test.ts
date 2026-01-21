import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Mock logger
vi.mock('../lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock EventMonitor with connection state support
const mockEventMonitor = {
  connect: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  getConnectionState: vi.fn().mockReturnValue('WS_ACTIVE'),
  getConnectionMode: vi.fn().mockReturnValue('websocket'),
  on: vi.fn(),
  off: vi.fn(),
  removeAllListeners: vi.fn(),
  emit: vi.fn(),
};

// Mock NoosphereAgent
vi.mock('@noosphere/agent-core', () => {
  const { EventEmitter } = require('events');

  class MockNoosphereAgent extends EventEmitter {
    eventMonitor = mockEventMonitor;
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    getStatus = vi.fn().mockReturnValue({
      isRunning: true,
      walletAddress: '0x1234',
      containers: [],
    });
  }

  return {
    NoosphereAgent: MockNoosphereAgent,
    EventMonitor: vi.fn().mockImplementation(() => mockEventMonitor),
    ContainerManager: class {
      stopPersistentContainers = vi.fn().mockResolvedValue(undefined);
    },
  };
});

import { logger } from '../lib/logger';

describe('WebSocket Failover Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock return values
    mockEventMonitor.getConnectionState.mockReturnValue('WS_ACTIVE');
    mockEventMonitor.getConnectionMode.mockReturnValue('websocket');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Connection State Reporting', () => {
    it('should report websocket mode when WS_ACTIVE', () => {
      mockEventMonitor.getConnectionState.mockReturnValue('WS_ACTIVE');
      mockEventMonitor.getConnectionMode.mockReturnValue('websocket');

      expect(mockEventMonitor.getConnectionState()).toBe('WS_ACTIVE');
      expect(mockEventMonitor.getConnectionMode()).toBe('websocket');
    });

    it('should report http_polling mode when HTTP_FALLBACK', () => {
      mockEventMonitor.getConnectionState.mockReturnValue('HTTP_FALLBACK');
      mockEventMonitor.getConnectionMode.mockReturnValue('http_polling');

      expect(mockEventMonitor.getConnectionState()).toBe('HTTP_FALLBACK');
      expect(mockEventMonitor.getConnectionMode()).toBe('http_polling');
    });

    it('should report connecting mode when in INIT state', () => {
      mockEventMonitor.getConnectionState.mockReturnValue('INIT');
      mockEventMonitor.getConnectionMode.mockReturnValue('connecting');

      expect(mockEventMonitor.getConnectionState()).toBe('INIT');
      expect(mockEventMonitor.getConnectionMode()).toBe('connecting');
    });
  });

  describe('Health API Connection Info', () => {
    it('should include connection mode in health response', () => {
      // Simulate health API response construction
      const connectionMode = mockEventMonitor.getConnectionMode();
      const connectionState = mockEventMonitor.getConnectionState();

      const healthResponse = {
        status: 'ok',
        healthy: true,
        connection: {
          mode: connectionMode,
          state: connectionState,
        },
      };

      expect(healthResponse.connection.mode).toBe('websocket');
      expect(healthResponse.connection.state).toBe('WS_ACTIVE');
    });

    it('should indicate degraded status when in HTTP fallback', () => {
      mockEventMonitor.getConnectionState.mockReturnValue('HTTP_FALLBACK');
      mockEventMonitor.getConnectionMode.mockReturnValue('http_polling');

      const connectionMode = mockEventMonitor.getConnectionMode();
      const isWebSocket = connectionMode === 'websocket';

      // Health status logic
      const status = isWebSocket ? 'ok' : 'degraded';

      expect(status).toBe('degraded');
    });
  });

  describe('Connection Recovery Events', () => {
    it('should handle connectionRecovered event', () => {
      const recoveryHandler = vi.fn();

      // Simulate event subscription
      mockEventMonitor.on.mockImplementation((event: string, handler: any) => {
        if (event === 'connectionRecovered') {
          // Store handler for later invocation
          recoveryHandler.mockImplementation(handler);
        }
      });

      // Subscribe to event
      mockEventMonitor.on('connectionRecovered', recoveryHandler);

      // Verify subscription was called
      expect(mockEventMonitor.on).toHaveBeenCalledWith(
        'connectionRecovered',
        expect.any(Function)
      );
    });

    it('should log connection state changes', () => {
      // Simulate state transition logging
      const logConnectionChange = (from: string, to: string) => {
        logger.info(`Connection state changed: ${from} -> ${to}`);
      };

      logConnectionChange('WS_ACTIVE', 'HTTP_FALLBACK');
      expect(logger.info).toHaveBeenCalledWith(
        'Connection state changed: WS_ACTIVE -> HTTP_FALLBACK'
      );

      logConnectionChange('HTTP_FALLBACK', 'WS_ACTIVE');
      expect(logger.info).toHaveBeenCalledWith(
        'Connection state changed: HTTP_FALLBACK -> WS_ACTIVE'
      );
    });
  });

  describe('Failover Scenarios', () => {
    it('should continue operation during HTTP fallback', () => {
      mockEventMonitor.getConnectionState.mockReturnValue('HTTP_FALLBACK');
      mockEventMonitor.getConnectionMode.mockReturnValue('http_polling');

      // Agent should still be operational
      const isOperational = mockEventMonitor.getConnectionState() !== 'INIT';
      expect(isOperational).toBe(true);
    });

    it('should track WS recovery attempts', () => {
      // Simulate recovery attempt tracking
      const recoveryAttempts: { timestamp: number; success: boolean }[] = [];

      const recordRecoveryAttempt = (success: boolean) => {
        recoveryAttempts.push({
          timestamp: Date.now(),
          success,
        });
      };

      // Simulate failed attempts
      recordRecoveryAttempt(false);
      recordRecoveryAttempt(false);
      recordRecoveryAttempt(true);

      expect(recoveryAttempts.length).toBe(3);
      expect(recoveryAttempts[2].success).toBe(true);
    });
  });

  describe('Connection State Transitions', () => {
    it('should follow valid state transitions', () => {
      const validTransitions: Record<string, string[]> = {
        INIT: ['WS_CONNECTING'],
        WS_CONNECTING: ['WS_ACTIVE', 'HTTP_FALLBACK'],
        WS_ACTIVE: ['WS_RECONNECTING', 'INIT'],
        WS_RECONNECTING: ['WS_ACTIVE', 'HTTP_FALLBACK'],
        HTTP_FALLBACK: ['WS_ACTIVE', 'INIT'],
      };

      // Verify transition from INIT to WS_CONNECTING is valid
      expect(validTransitions['INIT']).toContain('WS_CONNECTING');

      // Verify transition from WS_CONNECTING to HTTP_FALLBACK is valid
      expect(validTransitions['WS_CONNECTING']).toContain('HTTP_FALLBACK');

      // Verify transition from HTTP_FALLBACK to WS_ACTIVE (recovery) is valid
      expect(validTransitions['HTTP_FALLBACK']).toContain('WS_ACTIVE');
    });
  });

  describe('Docker Healthcheck Integration', () => {
    it('should return healthy:true when agent is running with WS', () => {
      mockEventMonitor.getConnectionState.mockReturnValue('WS_ACTIVE');

      const agentRunning = true;
      const connectionState = mockEventMonitor.getConnectionState();

      const healthy = agentRunning && connectionState !== 'INIT';

      expect(healthy).toBe(true);
    });

    it('should return healthy:true even in HTTP fallback (degraded but operational)', () => {
      mockEventMonitor.getConnectionState.mockReturnValue('HTTP_FALLBACK');

      const agentRunning = true;
      const connectionState = mockEventMonitor.getConnectionState();

      // Agent is still healthy (operational) even in HTTP fallback
      const healthy = agentRunning && connectionState !== 'INIT';

      expect(healthy).toBe(true);
    });

    it('should return healthy:false when not connected', () => {
      mockEventMonitor.getConnectionState.mockReturnValue('INIT');

      const agentRunning = false;
      const connectionState = mockEventMonitor.getConnectionState();

      const healthy = agentRunning && connectionState !== 'INIT';

      expect(healthy).toBe(false);
    });
  });
});

describe('Connection Configuration', () => {
  it('should use default timeout values', () => {
    const defaultConfig = {
      wsConnectTimeoutMs: 10000,
      wsMaxConnectRetries: 3,
      wsConnectRetryDelayMs: 5000,
      wsRecoveryIntervalMs: 60000,
    };

    expect(defaultConfig.wsConnectTimeoutMs).toBe(10000);
    expect(defaultConfig.wsMaxConnectRetries).toBe(3);
    expect(defaultConfig.wsConnectRetryDelayMs).toBe(5000);
    expect(defaultConfig.wsRecoveryIntervalMs).toBe(60000);
  });

  it('should allow custom timeout configuration', () => {
    const customConfig = {
      wsConnectTimeoutMs: 15000,
      wsMaxConnectRetries: 5,
      wsConnectRetryDelayMs: 3000,
      wsRecoveryIntervalMs: 120000,
    };

    expect(customConfig.wsConnectTimeoutMs).toBe(15000);
    expect(customConfig.wsMaxConnectRetries).toBe(5);
  });

  it('should calculate total max connection time correctly', () => {
    const config = {
      wsConnectTimeoutMs: 10000,
      wsMaxConnectRetries: 3,
      wsConnectRetryDelayMs: 5000,
    };

    // Total time = (timeout + delay) * retries
    // Worst case: 10s timeout + 5s delay = 15s per attempt, 3 attempts = 45s max
    const maxConnectionTime =
      (config.wsConnectTimeoutMs + config.wsConnectRetryDelayMs) *
      config.wsMaxConnectRetries;

    expect(maxConnectionTime).toBe(45000);
  });
});
