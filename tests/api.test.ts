import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';

describe('API Endpoints', () => {
  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      // Status is 'ok' when agents running, 'degraded' when no agents
      expect(['ok', 'degraded']).toContain(res.body.status);
      expect(res.body).toHaveProperty('timestamp');
      expect(typeof res.body.timestamp).toBe('number');
      // Should include agents info
      expect(res.body).toHaveProperty('agents');
      expect(res.body.agents).toHaveProperty('total');
      expect(res.body.agents).toHaveProperty('running');
      // Should include healthy field (Step 4)
      expect(res.body).toHaveProperty('healthy');
      expect(typeof res.body.healthy).toBe('boolean');
      // Should include connection info (Step 4)
      expect(res.body).toHaveProperty('connection');
      expect(res.body.connection).toHaveProperty('mode');
      expect(res.body.connection).toHaveProperty('state');
    });

    it('should return healthy:false when no agents running', async () => {
      const res = await request(app).get('/api/health');

      // In test environment, no agents are running
      if (res.body.agents.running === 0) {
        expect(res.body.healthy).toBe(false);
        expect(res.body.status).toBe('degraded');
      }
    });
  });

  describe('GET /api/stats', () => {
    it('should return event statistics', async () => {
      const res = await request(app).get('/api/stats');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('completed');
      expect(res.body).toHaveProperty('pending');
      expect(res.body).toHaveProperty('failed');
    });
  });

  describe('GET /api/agents', () => {
    it('should return agents list', async () => {
      const res = await request(app).get('/api/agents');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('totalAgents');
      expect(res.body).toHaveProperty('runningAgents');
      expect(res.body).toHaveProperty('agents');
      expect(Array.isArray(res.body.agents)).toBe(true);
    });
  });

  describe('GET /api/agents/:id', () => {
    it('should return 404 for non-existent agent', async () => {
      const res = await request(app).get('/api/agents/non-existent-agent');

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Agent not found');
    });
  });

  describe('POST /api/agents', () => {
    it('should return 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/agents')
        .send({ id: 'test-agent' });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toContain('required');
    });
  });

  describe('GET /api/scheduler', () => {
    it('should return scheduler status', async () => {
      const res = await request(app).get('/api/scheduler');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('enabled');
      expect(res.body).toHaveProperty('cronIntervalMs');
      expect(res.body).toHaveProperty('syncPeriodMs');
      expect(res.body).toHaveProperty('scheduler');
      expect(res.body).toHaveProperty('events');
    });
  });

  describe('GET /api/history', () => {
    it('should return history with pagination', async () => {
      const res = await request(app).get('/api/history?limit=10&offset=0');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('limit', 10);
      expect(res.body).toHaveProperty('offset', 0);
      expect(res.body).toHaveProperty('history');
      expect(Array.isArray(res.body.history)).toBe(true);
    });

    it('should filter history by status', async () => {
      const res = await request(app).get('/api/history?status=completed&limit=5');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('history');

      // All returned items should have status 'completed' if any exist
      res.body.history.forEach((item: any) => {
        expect(item.status).toBe('completed');
      });
    });
  });

  describe('GET /api/prepare-history', () => {
    it('should return prepare transaction history', async () => {
      const res = await request(app).get('/api/prepare-history?limit=10');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('stats');
      expect(res.body).toHaveProperty('pagination');
      expect(res.body).toHaveProperty('transactions');
      expect(res.body.stats).toHaveProperty('totalTxs');
      expect(res.body.stats).toHaveProperty('totalGasCostEth');
    });
  });

  describe('GET /api/containers', () => {
    it('should return containers list', async () => {
      const res = await request(app).get('/api/containers');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('stats');
      expect(res.body).toHaveProperty('containers');
      expect(Array.isArray(res.body.containers)).toBe(true);
    });
  });

  describe('GET /api/verifiers', () => {
    it('should return verifiers list', async () => {
      const res = await request(app).get('/api/verifiers');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('verifiers');
      expect(Array.isArray(res.body.verifiers)).toBe(true);
    });
  });

  describe('GET /api/metrics', () => {
    it('should return metrics in JSON format', async () => {
      const res = await request(app).get('/api/metrics');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('wsConnections');
      expect(res.body).toHaveProperty('requestsProcessed');
      expect(res.body).toHaveProperty('agentStarts');
      expect(res.body).toHaveProperty('uncaughtExceptions');
      expect(res.body).toHaveProperty('startedAt');
      expect(typeof res.body.startedAt).toBe('number');
    });
  });

  describe('GET /api/metrics/prometheus', () => {
    it('should return metrics in Prometheus format', async () => {
      const res = await request(app).get('/api/metrics/prometheus');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('noosphere_agent_info');
      expect(res.text).toContain('noosphere_ws_connections_total');
      expect(res.text).toContain('noosphere_requests_processed_total');
      expect(res.text).toContain('noosphere_uptime_seconds');
    });
  });
});
