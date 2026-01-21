/**
 * Step 8: Metrics Collection Service
 *
 * Collects and exposes operational metrics for monitoring:
 * - Connection state changes (WS/HTTP)
 * - Error counts and types
 * - Request processing stats
 * - Agent lifecycle events
 */

export interface MetricsData {
  // Connection metrics
  wsConnections: number;
  wsReconnects: number;
  httpFallbacks: number;
  rpcTimeouts: number;

  // Agent metrics
  agentStarts: number;
  agentStops: number;
  agentRestarts: number;
  agentStartFailures: number;

  // Request metrics
  requestsProcessed: number;
  requestsSucceeded: number;
  requestsFailed: number;
  requestsSkipped: number;

  // Error metrics
  uncaughtExceptions: number;
  unhandledRejections: number;

  // Timestamps
  startedAt: number;
  lastUpdatedAt: number;
}

class MetricsCollector {
  private metrics: MetricsData = {
    // Connection metrics
    wsConnections: 0,
    wsReconnects: 0,
    httpFallbacks: 0,
    rpcTimeouts: 0,

    // Agent metrics
    agentStarts: 0,
    agentStops: 0,
    agentRestarts: 0,
    agentStartFailures: 0,

    // Request metrics
    requestsProcessed: 0,
    requestsSucceeded: 0,
    requestsFailed: 0,
    requestsSkipped: 0,

    // Error metrics
    uncaughtExceptions: 0,
    unhandledRejections: 0,

    // Timestamps
    startedAt: Date.now(),
    lastUpdatedAt: Date.now(),
  };

  /**
   * Increment a metric counter
   */
  increment(metric: keyof Omit<MetricsData, 'startedAt' | 'lastUpdatedAt'>): void {
    if (metric in this.metrics && typeof this.metrics[metric] === 'number') {
      (this.metrics[metric] as number)++;
      this.metrics.lastUpdatedAt = Date.now();
    }
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): MetricsData {
    return { ...this.metrics };
  }

  /**
   * Get metrics in Prometheus exposition format
   */
  toPrometheus(): string {
    const lines: string[] = [
      '# HELP noosphere_agent_info Agent information',
      '# TYPE noosphere_agent_info gauge',
      `noosphere_agent_info{version="1.0.0"} 1`,
      '',
      '# HELP noosphere_ws_connections_total Total WebSocket connections',
      '# TYPE noosphere_ws_connections_total counter',
      `noosphere_ws_connections_total ${this.metrics.wsConnections}`,
      '',
      '# HELP noosphere_ws_reconnects_total Total WebSocket reconnection attempts',
      '# TYPE noosphere_ws_reconnects_total counter',
      `noosphere_ws_reconnects_total ${this.metrics.wsReconnects}`,
      '',
      '# HELP noosphere_http_fallbacks_total Total HTTP fallback activations',
      '# TYPE noosphere_http_fallbacks_total counter',
      `noosphere_http_fallbacks_total ${this.metrics.httpFallbacks}`,
      '',
      '# HELP noosphere_rpc_timeouts_total Total RPC timeout errors',
      '# TYPE noosphere_rpc_timeouts_total counter',
      `noosphere_rpc_timeouts_total ${this.metrics.rpcTimeouts}`,
      '',
      '# HELP noosphere_agent_starts_total Total agent start events',
      '# TYPE noosphere_agent_starts_total counter',
      `noosphere_agent_starts_total ${this.metrics.agentStarts}`,
      '',
      '# HELP noosphere_agent_stops_total Total agent stop events',
      '# TYPE noosphere_agent_stops_total counter',
      `noosphere_agent_stops_total ${this.metrics.agentStops}`,
      '',
      '# HELP noosphere_agent_restarts_total Total agent restart attempts',
      '# TYPE noosphere_agent_restarts_total counter',
      `noosphere_agent_restarts_total ${this.metrics.agentRestarts}`,
      '',
      '# HELP noosphere_agent_start_failures_total Total agent start failures',
      '# TYPE noosphere_agent_start_failures_total counter',
      `noosphere_agent_start_failures_total ${this.metrics.agentStartFailures}`,
      '',
      '# HELP noosphere_requests_processed_total Total requests processed',
      '# TYPE noosphere_requests_processed_total counter',
      `noosphere_requests_processed_total ${this.metrics.requestsProcessed}`,
      '',
      '# HELP noosphere_requests_succeeded_total Total successful requests',
      '# TYPE noosphere_requests_succeeded_total counter',
      `noosphere_requests_succeeded_total ${this.metrics.requestsSucceeded}`,
      '',
      '# HELP noosphere_requests_failed_total Total failed requests',
      '# TYPE noosphere_requests_failed_total counter',
      `noosphere_requests_failed_total ${this.metrics.requestsFailed}`,
      '',
      '# HELP noosphere_requests_skipped_total Total skipped requests',
      '# TYPE noosphere_requests_skipped_total counter',
      `noosphere_requests_skipped_total ${this.metrics.requestsSkipped}`,
      '',
      '# HELP noosphere_uncaught_exceptions_total Total uncaught exceptions',
      '# TYPE noosphere_uncaught_exceptions_total counter',
      `noosphere_uncaught_exceptions_total ${this.metrics.uncaughtExceptions}`,
      '',
      '# HELP noosphere_unhandled_rejections_total Total unhandled promise rejections',
      '# TYPE noosphere_unhandled_rejections_total counter',
      `noosphere_unhandled_rejections_total ${this.metrics.unhandledRejections}`,
      '',
      '# HELP noosphere_uptime_seconds Agent uptime in seconds',
      '# TYPE noosphere_uptime_seconds gauge',
      `noosphere_uptime_seconds ${Math.floor((Date.now() - this.metrics.startedAt) / 1000)}`,
    ];

    return lines.join('\n');
  }

  /**
   * Reset all metrics (useful for testing)
   */
  reset(): void {
    this.metrics = {
      wsConnections: 0,
      wsReconnects: 0,
      httpFallbacks: 0,
      rpcTimeouts: 0,
      agentStarts: 0,
      agentStops: 0,
      agentRestarts: 0,
      agentStartFailures: 0,
      requestsProcessed: 0,
      requestsSucceeded: 0,
      requestsFailed: 0,
      requestsSkipped: 0,
      uncaughtExceptions: 0,
      unhandledRejections: 0,
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
    };
  }
}

// Singleton instance
let metricsInstance: MetricsCollector | null = null;

/**
 * Get the global metrics collector instance
 */
export function getMetrics(): MetricsCollector {
  if (!metricsInstance) {
    metricsInstance = new MetricsCollector();
  }
  return metricsInstance;
}

export { MetricsCollector };
