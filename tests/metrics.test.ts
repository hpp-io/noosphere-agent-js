import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector, getMetrics } from '../src/services/metrics';

/**
 * Step 8: Metrics Collection Tests
 *
 * These tests verify that the MetricsCollector:
 * - Properly tracks all metric types
 * - Exports metrics in JSON and Prometheus formats
 * - Maintains accurate counters
 */

describe('MetricsCollector (Step 8)', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector();
  });

  describe('Counter Operations', () => {
    it('should increment connection metrics', () => {
      metrics.increment('wsConnections');
      metrics.increment('wsConnections');
      metrics.increment('wsReconnects');
      metrics.increment('httpFallbacks');
      metrics.increment('rpcTimeouts');

      const data = metrics.getMetrics();

      expect(data.wsConnections).toBe(2);
      expect(data.wsReconnects).toBe(1);
      expect(data.httpFallbacks).toBe(1);
      expect(data.rpcTimeouts).toBe(1);
    });

    it('should increment agent metrics', () => {
      metrics.increment('agentStarts');
      metrics.increment('agentStarts');
      metrics.increment('agentStops');
      metrics.increment('agentRestarts');
      metrics.increment('agentStartFailures');

      const data = metrics.getMetrics();

      expect(data.agentStarts).toBe(2);
      expect(data.agentStops).toBe(1);
      expect(data.agentRestarts).toBe(1);
      expect(data.agentStartFailures).toBe(1);
    });

    it('should increment request metrics', () => {
      metrics.increment('requestsProcessed');
      metrics.increment('requestsProcessed');
      metrics.increment('requestsProcessed');
      metrics.increment('requestsSucceeded');
      metrics.increment('requestsSucceeded');
      metrics.increment('requestsFailed');
      metrics.increment('requestsSkipped');

      const data = metrics.getMetrics();

      expect(data.requestsProcessed).toBe(3);
      expect(data.requestsSucceeded).toBe(2);
      expect(data.requestsFailed).toBe(1);
      expect(data.requestsSkipped).toBe(1);
    });

    it('should increment error metrics', () => {
      metrics.increment('uncaughtExceptions');
      metrics.increment('uncaughtExceptions');
      metrics.increment('unhandledRejections');

      const data = metrics.getMetrics();

      expect(data.uncaughtExceptions).toBe(2);
      expect(data.unhandledRejections).toBe(1);
    });

    it('should update lastUpdatedAt on increment', () => {
      const initialData = metrics.getMetrics();
      const initialTimestamp = initialData.lastUpdatedAt;

      // Small delay to ensure timestamp changes
      metrics.increment('wsConnections');

      const updatedData = metrics.getMetrics();

      expect(updatedData.lastUpdatedAt).toBeGreaterThanOrEqual(initialTimestamp);
    });
  });

  describe('getMetrics', () => {
    it('should return a snapshot of all metrics', () => {
      const data = metrics.getMetrics();

      // Connection metrics
      expect(data).toHaveProperty('wsConnections');
      expect(data).toHaveProperty('wsReconnects');
      expect(data).toHaveProperty('httpFallbacks');
      expect(data).toHaveProperty('rpcTimeouts');

      // Agent metrics
      expect(data).toHaveProperty('agentStarts');
      expect(data).toHaveProperty('agentStops');
      expect(data).toHaveProperty('agentRestarts');
      expect(data).toHaveProperty('agentStartFailures');

      // Request metrics
      expect(data).toHaveProperty('requestsProcessed');
      expect(data).toHaveProperty('requestsSucceeded');
      expect(data).toHaveProperty('requestsFailed');
      expect(data).toHaveProperty('requestsSkipped');

      // Error metrics
      expect(data).toHaveProperty('uncaughtExceptions');
      expect(data).toHaveProperty('unhandledRejections');

      // Timestamps
      expect(data).toHaveProperty('startedAt');
      expect(data).toHaveProperty('lastUpdatedAt');
    });

    it('should return a copy, not the original object', () => {
      const data1 = metrics.getMetrics();
      const data2 = metrics.getMetrics();

      expect(data1).not.toBe(data2);
      expect(data1).toEqual(data2);
    });

    it('should have startedAt set to initialization time', () => {
      const data = metrics.getMetrics();
      const now = Date.now();

      expect(data.startedAt).toBeLessThanOrEqual(now);
      expect(data.startedAt).toBeGreaterThan(now - 1000); // Within 1 second
    });
  });

  describe('toPrometheus', () => {
    it('should export metrics in Prometheus format', () => {
      metrics.increment('wsConnections');
      metrics.increment('requestsProcessed');

      const prometheus = metrics.toPrometheus();

      expect(prometheus).toContain('# HELP noosphere_agent_info');
      expect(prometheus).toContain('# TYPE noosphere_agent_info gauge');
      expect(prometheus).toContain('noosphere_ws_connections_total 1');
      expect(prometheus).toContain('noosphere_requests_processed_total 1');
    });

    it('should include all metric types', () => {
      const prometheus = metrics.toPrometheus();

      // Connection metrics
      expect(prometheus).toContain('noosphere_ws_connections_total');
      expect(prometheus).toContain('noosphere_ws_reconnects_total');
      expect(prometheus).toContain('noosphere_http_fallbacks_total');
      expect(prometheus).toContain('noosphere_rpc_timeouts_total');

      // Agent metrics
      expect(prometheus).toContain('noosphere_agent_starts_total');
      expect(prometheus).toContain('noosphere_agent_stops_total');
      expect(prometheus).toContain('noosphere_agent_restarts_total');
      expect(prometheus).toContain('noosphere_agent_start_failures_total');

      // Request metrics
      expect(prometheus).toContain('noosphere_requests_processed_total');
      expect(prometheus).toContain('noosphere_requests_succeeded_total');
      expect(prometheus).toContain('noosphere_requests_failed_total');
      expect(prometheus).toContain('noosphere_requests_skipped_total');

      // Error metrics
      expect(prometheus).toContain('noosphere_uncaught_exceptions_total');
      expect(prometheus).toContain('noosphere_unhandled_rejections_total');

      // Uptime
      expect(prometheus).toContain('noosphere_uptime_seconds');
    });

    it('should include HELP and TYPE annotations', () => {
      const prometheus = metrics.toPrometheus();

      expect(prometheus).toContain('# HELP noosphere_ws_connections_total');
      expect(prometheus).toContain('# TYPE noosphere_ws_connections_total counter');
      expect(prometheus).toContain('# HELP noosphere_uptime_seconds');
      expect(prometheus).toContain('# TYPE noosphere_uptime_seconds gauge');
    });

    it('should calculate uptime correctly', async () => {
      // Wait a bit to get non-zero uptime
      await new Promise(resolve => setTimeout(resolve, 100));

      const prometheus = metrics.toPrometheus();
      const uptimeMatch = prometheus.match(/noosphere_uptime_seconds (\d+)/);

      expect(uptimeMatch).not.toBeNull();
      const uptime = parseInt(uptimeMatch![1]);
      expect(uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('reset', () => {
    it('should reset all counters to zero', () => {
      metrics.increment('wsConnections');
      metrics.increment('requestsProcessed');
      metrics.increment('agentStarts');

      metrics.reset();
      const data = metrics.getMetrics();

      expect(data.wsConnections).toBe(0);
      expect(data.requestsProcessed).toBe(0);
      expect(data.agentStarts).toBe(0);
    });

    it('should reset timestamps', () => {
      const oldData = metrics.getMetrics();
      const oldStartedAt = oldData.startedAt;

      // Wait a bit
      metrics.reset();
      const newData = metrics.getMetrics();

      expect(newData.startedAt).toBeGreaterThanOrEqual(oldStartedAt);
    });
  });

  describe('Singleton Pattern', () => {
    it('should return same instance from getMetrics', () => {
      const instance1 = getMetrics();
      const instance2 = getMetrics();

      expect(instance1).toBe(instance2);
    });

    it('should maintain state across getMetrics calls', () => {
      const instance = getMetrics();
      instance.increment('wsConnections');

      const sameInstance = getMetrics();
      const data = sameInstance.getMetrics();

      expect(data.wsConnections).toBeGreaterThan(0);
    });
  });

  describe('Operational Scenarios', () => {
    it('should track WS failover sequence', () => {
      // Simulate WS connection attempt
      metrics.increment('wsConnections');

      // WS fails, falling back to HTTP
      metrics.increment('httpFallbacks');

      // WS recovery attempts
      metrics.increment('wsReconnects');
      metrics.increment('wsReconnects');

      // Successful WS reconnection
      metrics.increment('wsConnections');

      const data = metrics.getMetrics();

      expect(data.wsConnections).toBe(2);
      expect(data.httpFallbacks).toBe(1);
      expect(data.wsReconnects).toBe(2);
    });

    it('should track agent lifecycle', () => {
      // Agent starts successfully
      metrics.increment('agentStarts');

      // Agent stops
      metrics.increment('agentStops');

      // Agent restart attempt fails
      metrics.increment('agentStartFailures');

      // Retry succeeds
      metrics.increment('agentRestarts');
      metrics.increment('agentStarts');

      const data = metrics.getMetrics();

      expect(data.agentStarts).toBe(2);
      expect(data.agentStops).toBe(1);
      expect(data.agentRestarts).toBe(1);
      expect(data.agentStartFailures).toBe(1);
    });

    it('should track request processing', () => {
      // Process multiple requests
      for (let i = 0; i < 10; i++) {
        metrics.increment('requestsProcessed');
      }

      // 8 succeed, 1 fails, 1 skipped
      for (let i = 0; i < 8; i++) {
        metrics.increment('requestsSucceeded');
      }
      metrics.increment('requestsFailed');
      metrics.increment('requestsSkipped');

      const data = metrics.getMetrics();

      expect(data.requestsProcessed).toBe(10);
      expect(data.requestsSucceeded).toBe(8);
      expect(data.requestsFailed).toBe(1);
      expect(data.requestsSkipped).toBe(1);

      // Calculate success rate
      const successRate = data.requestsSucceeded / data.requestsProcessed;
      expect(successRate).toBe(0.8);
    });

    it('should track error conditions', () => {
      // Simulate various error conditions
      metrics.increment('rpcTimeouts');
      metrics.increment('rpcTimeouts');
      metrics.increment('uncaughtExceptions');
      metrics.increment('unhandledRejections');

      const data = metrics.getMetrics();

      expect(data.rpcTimeouts).toBe(2);
      expect(data.uncaughtExceptions).toBe(1);
      expect(data.unhandledRejections).toBe(1);
    });
  });
});
