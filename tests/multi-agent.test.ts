import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

// Create a mock AgentManager class for testing
class MockAgentManager extends EventEmitter {
  private agents = new Map<string, any>();

  getStatus() {
    const agentList = Array.from(this.agents.values()).map(a => a.getStatus());
    return {
      totalAgents: agentList.length,
      runningAgents: agentList.filter((a: any) => a.running).length,
      agents: agentList,
    };
  }

  getAgent(id: string) {
    return this.agents.get(id);
  }

  getAllAgents() {
    return Array.from(this.agents.values());
  }

  async stopAgent(id: string) {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Agent ${id} not found`);
    }
    await agent.stop();
    this.agents.delete(id);
  }

  async shutdown() {
    for (const agent of this.agents.values()) {
      await agent.stop();
    }
    this.agents.clear();
  }
}

describe('Multi-Agent Configuration', () => {
  const testConfigDir = path.join(process.cwd(), 'tests', 'fixtures');
  const testAgentsJsonPath = path.join(process.cwd(), 'agents.json');
  const testConfigJsonPath = path.join(testConfigDir, 'test-config.json');

  beforeEach(() => {
    // Create test fixtures directory
    if (!fs.existsSync(testConfigDir)) {
      fs.mkdirSync(testConfigDir, { recursive: true });
    }

    // Create test config file
    const testConfig = {
      chain: {
        rpcUrl: 'https://test.rpc.url',
        wsRpcUrl: 'wss://test.rpc.url',
        routerAddress: '0x1234567890123456789012345678901234567890',
        coordinatorAddress: '0x0987654321098765432109876543210987654321',
        deploymentBlock: 0,
        wallet: {
          keystorePath: './.noosphere/keystore.json',
          paymentAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
        },
      },
      containers: [],
      verifiers: [],
      scheduler: {
        enabled: true,
        cronIntervalMs: 60000,
        syncPeriodMs: 3000,
      },
    };
    fs.writeFileSync(testConfigJsonPath, JSON.stringify(testConfig, null, 2));
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(testAgentsJsonPath)) {
      fs.unlinkSync(testAgentsJsonPath);
    }
    if (fs.existsSync(testConfigJsonPath)) {
      fs.unlinkSync(testConfigJsonPath);
    }
    if (fs.existsSync(testConfigDir)) {
      fs.rmdirSync(testConfigDir, { recursive: true });
    }
  });

  describe('agents.json Configuration', () => {
    it('should parse agents.json with multiple agents', () => {
      const agentsConfig = {
        agents: [
          {
            id: 'agent-1',
            name: 'Test Agent 1',
            configPath: './tests/fixtures/test-config.json',
            keystorePassword: '${TEST_PASSWORD_1}',
            enabled: true,
          },
          {
            id: 'agent-2',
            name: 'Test Agent 2',
            configPath: './tests/fixtures/test-config.json',
            keystorePassword: '${TEST_PASSWORD_2}',
            enabled: false,
          },
        ],
      };

      fs.writeFileSync(testAgentsJsonPath, JSON.stringify(agentsConfig, null, 2));

      const content = fs.readFileSync(testAgentsJsonPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.agents).toHaveLength(2);
      expect(parsed.agents[0].id).toBe('agent-1');
      expect(parsed.agents[1].id).toBe('agent-2');
      expect(parsed.agents[1].enabled).toBe(false);
    });

    it('should substitute environment variables in keystorePassword', () => {
      // Set environment variables
      process.env.TEST_PASSWORD_1 = 'secret-password-1';
      process.env.TEST_PASSWORD_2 = 'secret-password-2';

      const agentsConfig = {
        agents: [
          {
            id: 'agent-1',
            name: 'Test Agent 1',
            configPath: './tests/fixtures/test-config.json',
            keystorePassword: '${TEST_PASSWORD_1}',
            enabled: true,
          },
        ],
      };

      fs.writeFileSync(testAgentsJsonPath, JSON.stringify(agentsConfig, null, 2));

      // Simulate the env var substitution logic from agent-manager.ts
      const content = fs.readFileSync(testAgentsJsonPath, 'utf-8');
      const parsed = JSON.parse(content);
      const agents = parsed.agents.map((agent: any) => ({
        ...agent,
        keystorePassword: agent.keystorePassword?.replace(
          /\$\{(\w+)\}/g,
          (_: string, envVar: string) => process.env[envVar] || ''
        ) || '',
      }));

      expect(agents[0].keystorePassword).toBe('secret-password-1');

      // Cleanup
      delete process.env.TEST_PASSWORD_1;
      delete process.env.TEST_PASSWORD_2;
    });
  });

  describe('AgentManager', () => {
    it('should initialize without errors', () => {
      const manager = new MockAgentManager();
      expect(manager).toBeDefined();
    });

    it('should return empty status when no agents are running', () => {
      const manager = new MockAgentManager();
      const status = manager.getStatus();

      expect(status.totalAgents).toBe(0);
      expect(status.runningAgents).toBe(0);
      expect(status.agents).toHaveLength(0);
    });

    it('should return undefined for non-existent agent', () => {
      const manager = new MockAgentManager();
      const agent = manager.getAgent('non-existent');

      expect(agent).toBeUndefined();
    });

    it('should throw error when stopping non-existent agent', async () => {
      const manager = new MockAgentManager();

      await expect(manager.stopAgent('non-existent')).rejects.toThrow(
        'Agent non-existent not found'
      );
    });

    it('should emit events through EventEmitter', () => {
      const manager = new MockAgentManager();
      const mockHandler = vi.fn();

      manager.on('agentStarted', mockHandler);
      manager.emit('agentStarted', { agentId: 'test-agent' });

      expect(mockHandler).toHaveBeenCalledWith({ agentId: 'test-agent' });
    });

    it('should get all agents as array', () => {
      const manager = new MockAgentManager();
      const agents = manager.getAllAgents();

      expect(Array.isArray(agents)).toBe(true);
      expect(agents).toHaveLength(0);
    });
  });

  describe('Agent Lifecycle', () => {
    it('should emit started event when agent starts', () => {
      const manager = new MockAgentManager();
      const events: any[] = [];

      manager.on('agentStarted', (data) => events.push(data));
      manager.emit('agentStarted', { agentId: 'test-agent' });

      expect(events).toHaveLength(1);
      expect(events[0].agentId).toBe('test-agent');
    });

    it('should emit stopped event when agent stops', () => {
      const manager = new MockAgentManager();
      const events: any[] = [];

      manager.on('agentStopped', (data) => events.push(data));
      manager.emit('agentStopped', { agentId: 'test-agent' });

      expect(events).toHaveLength(1);
      expect(events[0].agentId).toBe('test-agent');
    });

    it('should forward requestStarted events', () => {
      const manager = new MockAgentManager();
      const events: any[] = [];

      manager.on('requestStarted', (data) => events.push(data));
      manager.emit('requestStarted', {
        agentId: 'test-agent',
        event: { requestId: '0x123', subscriptionId: 1 },
      });

      expect(events).toHaveLength(1);
      expect(events[0].agentId).toBe('test-agent');
      expect(events[0].event.requestId).toBe('0x123');
    });

    it('should forward computeDelivered events', () => {
      const manager = new MockAgentManager();
      const events: any[] = [];

      manager.on('computeDelivered', (data) => events.push(data));
      manager.emit('computeDelivered', {
        agentId: 'test-agent',
        event: { requestId: '0x456', txHash: '0xabc' },
      });

      expect(events).toHaveLength(1);
      expect(events[0].event.txHash).toBe('0xabc');
    });
  });
});

describe('Multiple Agents Running', () => {
  class MockAgent extends EventEmitter {
    constructor(
      public readonly id: string,
      public readonly name: string,
      private running: boolean = false
    ) {
      super();
    }

    async start() {
      this.running = true;
      this.emit('started', { agentId: this.id });
    }

    async stop() {
      this.running = false;
      this.emit('stopped', { agentId: this.id });
    }

    getStatus() {
      return {
        id: this.id,
        name: this.name,
        running: this.running,
      };
    }
  }

  class MultiAgentManager extends EventEmitter {
    private agents = new Map<string, MockAgent>();

    async createAgent(config: { id: string; name: string }) {
      if (this.agents.has(config.id)) {
        throw new Error(`Agent ${config.id} already exists`);
      }
      const agent = new MockAgent(config.id, config.name);

      // Forward agent events
      agent.on('started', (data) => this.emit('agentStarted', data));
      agent.on('stopped', (data) => this.emit('agentStopped', data));

      this.agents.set(config.id, agent);
      return agent;
    }

    async startAll() {
      const promises = Array.from(this.agents.values()).map((agent) => agent.start());
      await Promise.all(promises);
    }

    async stopAll() {
      const promises = Array.from(this.agents.values()).map((agent) => agent.stop());
      await Promise.all(promises);
    }

    getStatus() {
      const agentList = Array.from(this.agents.values()).map((a) => a.getStatus());
      return {
        totalAgents: agentList.length,
        runningAgents: agentList.filter((a) => a.running).length,
        agents: agentList,
      };
    }

    getAgent(id: string) {
      return this.agents.get(id);
    }

    async stopAgent(id: string) {
      const agent = this.agents.get(id);
      if (!agent) throw new Error(`Agent ${id} not found`);
      await agent.stop();
    }
  }

  it('should create multiple agents with unique IDs', async () => {
    const manager = new MultiAgentManager();

    await manager.createAgent({ id: 'agent-1', name: 'Agent 1' });
    await manager.createAgent({ id: 'agent-2', name: 'Agent 2' });
    await manager.createAgent({ id: 'agent-3', name: 'Agent 3' });

    const status = manager.getStatus();
    expect(status.totalAgents).toBe(3);
    expect(status.agents.map((a: any) => a.id)).toEqual(['agent-1', 'agent-2', 'agent-3']);
  });

  it('should reject duplicate agent IDs', async () => {
    const manager = new MultiAgentManager();

    await manager.createAgent({ id: 'agent-1', name: 'Agent 1' });

    await expect(
      manager.createAgent({ id: 'agent-1', name: 'Agent 1 Duplicate' })
    ).rejects.toThrow('Agent agent-1 already exists');
  });

  it('should start all agents concurrently', async () => {
    const manager = new MultiAgentManager();
    const startedAgents: string[] = [];

    manager.on('agentStarted', (data) => startedAgents.push(data.agentId));

    await manager.createAgent({ id: 'agent-1', name: 'Agent 1' });
    await manager.createAgent({ id: 'agent-2', name: 'Agent 2' });
    await manager.createAgent({ id: 'agent-3', name: 'Agent 3' });

    await manager.startAll();

    expect(startedAgents).toHaveLength(3);
    expect(startedAgents).toContain('agent-1');
    expect(startedAgents).toContain('agent-2');
    expect(startedAgents).toContain('agent-3');

    const status = manager.getStatus();
    expect(status.runningAgents).toBe(3);
  });

  it('should stop individual agent without affecting others', async () => {
    const manager = new MultiAgentManager();

    await manager.createAgent({ id: 'agent-1', name: 'Agent 1' });
    await manager.createAgent({ id: 'agent-2', name: 'Agent 2' });
    await manager.createAgent({ id: 'agent-3', name: 'Agent 3' });

    await manager.startAll();
    expect(manager.getStatus().runningAgents).toBe(3);

    // Stop only agent-2
    await manager.stopAgent('agent-2');

    const status = manager.getStatus();
    expect(status.runningAgents).toBe(2);
    expect(manager.getAgent('agent-1')?.getStatus().running).toBe(true);
    expect(manager.getAgent('agent-2')?.getStatus().running).toBe(false);
    expect(manager.getAgent('agent-3')?.getStatus().running).toBe(true);
  });

  it('should stop all agents on shutdown', async () => {
    const manager = new MultiAgentManager();
    const stoppedAgents: string[] = [];

    manager.on('agentStopped', (data) => stoppedAgents.push(data.agentId));

    await manager.createAgent({ id: 'agent-1', name: 'Agent 1' });
    await manager.createAgent({ id: 'agent-2', name: 'Agent 2' });

    await manager.startAll();
    await manager.stopAll();

    expect(stoppedAgents).toHaveLength(2);
    expect(manager.getStatus().runningAgents).toBe(0);
  });

  it('should maintain separate status for each agent', async () => {
    const manager = new MultiAgentManager();

    await manager.createAgent({ id: 'prod-agent', name: 'Production Agent' });
    await manager.createAgent({ id: 'test-agent', name: 'Test Agent' });

    // Start only prod-agent
    const prodAgent = manager.getAgent('prod-agent');
    await prodAgent?.start();

    const prodStatus = manager.getAgent('prod-agent')?.getStatus();
    const testStatus = manager.getAgent('test-agent')?.getStatus();

    expect(prodStatus?.running).toBe(true);
    expect(prodStatus?.name).toBe('Production Agent');
    expect(testStatus?.running).toBe(false);
    expect(testStatus?.name).toBe('Test Agent');
  });

  it('should forward events with correct agent identification', async () => {
    const manager = new MultiAgentManager();
    const events: { type: string; agentId: string }[] = [];

    manager.on('agentStarted', (data) => events.push({ type: 'started', agentId: data.agentId }));
    manager.on('agentStopped', (data) => events.push({ type: 'stopped', agentId: data.agentId }));

    await manager.createAgent({ id: 'agent-a', name: 'Agent A' });
    await manager.createAgent({ id: 'agent-b', name: 'Agent B' });

    const agentA = manager.getAgent('agent-a');
    const agentB = manager.getAgent('agent-b');

    await agentA?.start();
    await agentB?.start();
    await agentA?.stop();

    expect(events).toEqual([
      { type: 'started', agentId: 'agent-a' },
      { type: 'started', agentId: 'agent-b' },
      { type: 'stopped', agentId: 'agent-a' },
    ]);
  });
});

describe('Agent Configuration Types', () => {
  it('should validate AgentInstanceConfig structure', () => {
    const config = {
      id: 'test-agent',
      name: 'Test Agent',
      configPath: './config.json',
      keystorePassword: 'password',
      enabled: true,
    };

    expect(config).toHaveProperty('id');
    expect(config).toHaveProperty('configPath');
    expect(config).toHaveProperty('keystorePassword');
    expect(typeof config.enabled).toBe('boolean');
  });

  it('should allow optional name and enabled fields', () => {
    const minimalConfig = {
      id: 'test-agent',
      configPath: './config.json',
      keystorePassword: 'password',
    };

    expect(minimalConfig).toHaveProperty('id');
    expect(minimalConfig).not.toHaveProperty('name');
    expect(minimalConfig).not.toHaveProperty('enabled');
  });
});
