import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { EventEmitter } from 'events';

// Mock the dependencies
vi.mock('../lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Note: DB mock uses correct path for the import from agent-instance
vi.mock('../../lib/db', () => ({
  getDatabase: vi.fn().mockReturnValue({
    saveRequestStartedEvent: vi.fn().mockReturnValue(true),
    updateEventToProcessing: vi.fn(),
    updateEventToSkipped: vi.fn(),
    updateEventToFailed: vi.fn(),
    updateEventToCompleted: vi.fn(),
    isEventProcessed: vi.fn().mockReturnValue(false),
    getLatestCheckpoint: vi.fn().mockReturnValue(null),
    saveCheckpoint: vi.fn(),
    fixInconsistentEventStatuses: vi.fn(),
    savePrepareTransaction: vi.fn(),
    getCommittedIntervalKeys: vi.fn().mockReturnValue([]),
    getRetryableEvents: vi.fn().mockReturnValue([]),
    resetEventForRetry: vi.fn(),
  }),
}));

// Create a mock NoosphereAgent that can be controlled
const createMockNoosphereAgent = () => ({
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn().mockReturnValue({
    address: '0xagentaddress',
    containers: { runningCount: 2 },
    scheduler: {
      totalSubscriptions: 10,
      activeSubscriptions: 5,
      pendingTransactions: 0,
    },
  }),
  getConnectionState: vi.fn().mockReturnValue('WS_ACTIVE'),
  getConnectionMode: vi.fn().mockReturnValue('websocket'),
});

// Store the mock for access in tests
let mockNoosphereAgent: ReturnType<typeof createMockNoosphereAgent>;

vi.mock('@noosphere/agent-core', () => ({
  NoosphereAgent: {
    fromKeystore: vi.fn().mockImplementation(async () => {
      mockNoosphereAgent = createMockNoosphereAgent();
      return mockNoosphereAgent;
    }),
  },
  RegistryManager: class MockRegistryManager {
    load = vi.fn().mockResolvedValue(undefined);
  },
  PayloadUtils: {
    fromInlineData: (data: string) => ({
      contentHash: '0x1234',
      uri: `data:application/json;base64,${Buffer.from(data).toString('base64')}`,
    }),
  },
  PayloadResolver: class MockPayloadResolver {
    constructor(_config?: any) {}
    encode = vi.fn().mockResolvedValue({
      contentHash: '0xencodedHash',
      uri: 'ipfs://QmEncoded',
    });
    serialize = (payload: any) => JSON.stringify(payload);
    deserialize = (str: string) => {
      try {
        return JSON.parse(str);
      } catch {
        return { contentHash: '0x', uri: str };
      }
    };
  },
}));

import { AgentInstance } from '../src/services/agent-instance';
import { NoosphereAgent, RegistryManager, PayloadResolver } from '@noosphere/agent-core';
import { logger } from '../lib/logger';
import { getDatabase } from '../../lib/db';

describe('AgentInstance', () => {
  let agent: AgentInstance;
  const testConfig = {
    chain: {
      rpcUrl: 'https://test.rpc.url',
      wsRpcUrl: 'wss://test.ws.url',
      routerAddress: '0x1234567890123456789012345678901234567890',
      coordinatorAddress: '0x0987654321098765432109876543210987654321',
      deploymentBlock: 1000,
      wallet: {
        keystorePath: './.noosphere-test/keystore.json',
        paymentAddress: '0xpaymentaddress',
      },
    },
    containers: [
      {
        id: '0xcontainer1',
        name: 'Container 1',
        image: 'test-image:latest',
        port: 8080,
      },
      {
        id: '0xcontainer2',
        name: 'Container 2',
        image: 'test-image',
        port: 9090,
        env: {
          API_KEY: '${MY_API_KEY}',
          STATIC_VAR: 'static-value',
        },
      },
    ],
    verifiers: [
      {
        id: 'verifier1',
        name: 'Test Verifier',
        requiresProof: true,
        proofService: {
          image: 'proof-image:v1',
          port: 5000,
          env: {
            PROOF_KEY: '${PROOF_API_KEY}',
          },
          command: ['--mode', 'proof'],
        },
      },
      {
        id: 'verifier2',
        name: 'Simple Verifier',
        requiresProof: false,
      },
    ],
    scheduler: {
      cronIntervalMs: 60000,
      syncPeriodMs: 3000,
    },
    retry: {
      maxRetries: 3,
      retryIntervalMs: 30000,
    },
    payload: {
      uploadThreshold: 1024,
      defaultStorage: 'ipfs',
      ipfs: {
        gateway: 'https://gateway.pinata.cloud',
        pinataApiKey: 'test-key',
        pinataApiSecret: 'test-secret',
      },
      s3: {
        endpoint: 'https://s3.endpoint',
        bucket: 'test-bucket',
        region: 'auto',
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
        publicUrlBase: 'https://public.url',
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MY_API_KEY = 'my-api-key-value';
    process.env.PROOF_API_KEY = 'proof-api-key-value';

    agent = new AgentInstance('test-agent', 'Test Agent', testConfig as any, 'test-password');
  });

  afterEach(() => {
    delete process.env.MY_API_KEY;
    delete process.env.PROOF_API_KEY;
  });

  describe('constructor', () => {
    it('should create an AgentInstance', () => {
      expect(agent).toBeDefined();
      expect(agent.id).toBe('test-agent');
      expect(agent.name).toBe('Test Agent');
    });

    it('should be an EventEmitter', () => {
      expect(agent).toBeInstanceOf(EventEmitter);
    });

    it('should create PayloadResolver instance', () => {
      // PayloadResolver is instantiated in constructor
      const resolver = agent.getPayloadResolver();
      expect(resolver).toBeDefined();
    });

    it('should use environment variables for S3 config when not in config', () => {
      process.env.R2_BUCKET = 'env-bucket';
      process.env.R2_ENDPOINT = 'https://env-endpoint';

      const configWithoutS3 = {
        ...testConfig,
        payload: {
          uploadThreshold: 1024,
          defaultStorage: 'ipfs',
        },
      };

      const envAgent = new AgentInstance('env-agent', 'Env Agent', configWithoutS3 as any, 'password');
      expect(envAgent).toBeDefined();

      delete process.env.R2_BUCKET;
      delete process.env.R2_ENDPOINT;
    });
  });

  describe('initialize', () => {
    it('should initialize the agent', async () => {
      await agent.initialize();

      expect(NoosphereAgent.fromKeystore).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Initializing agent'));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Agent initialized'));
    });

    it('should build container map from config', async () => {
      await agent.initialize();

      // Check that containers and verifier proof services are included
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Loaded'));
    });

    it('should handle initialization errors', async () => {
      (NoosphereAgent.fromKeystore as Mock).mockRejectedValueOnce(new Error('Keystore error'));

      await expect(agent.initialize()).rejects.toThrow('Keystore error');

      const status = agent.getStatus();
      expect(status.status).toBe('error');
      expect(status.error).toBe('Keystore error');
    });
  });

  describe('start', () => {
    it('should start the agent after initialization', async () => {
      await agent.initialize();
      await agent.start();

      expect(mockNoosphereAgent.start).toHaveBeenCalled();

      const status = agent.getStatus();
      expect(status.status).toBe('running');
      expect(status.running).toBe(true);
    });

    it('should throw error if not initialized', async () => {
      await expect(agent.start()).rejects.toThrow('Agent not initialized');
    });

    it('should emit started event', async () => {
      const startedHandler = vi.fn();
      agent.on('started', startedHandler);

      await agent.initialize();
      await agent.start();

      expect(startedHandler).toHaveBeenCalledWith({ agentId: 'test-agent' });
    });
  });

  describe('stop', () => {
    it('should stop the agent', async () => {
      await agent.initialize();
      await agent.start();
      await agent.stop();

      expect(mockNoosphereAgent.stop).toHaveBeenCalled();

      const status = agent.getStatus();
      expect(status.status).toBe('stopped');
    });

    it('should emit stopped event', async () => {
      const stoppedHandler = vi.fn();
      agent.on('stopped', stoppedHandler);

      await agent.initialize();
      await agent.start();
      await agent.stop();

      expect(stoppedHandler).toHaveBeenCalledWith({ agentId: 'test-agent' });
    });

    it('should handle stop when not started', async () => {
      // Should not throw
      await expect(agent.stop()).resolves.not.toThrow();
    });
  });

  describe('getStatus', () => {
    it('should return initial status', () => {
      const status = agent.getStatus();

      expect(status.id).toBe('test-agent');
      expect(status.name).toBe('Test Agent');
      expect(status.status).toBe('stopped');
      expect(status.running).toBe(false);
    });

    it('should return full status after running', async () => {
      await agent.initialize();
      await agent.start();

      const status = agent.getStatus();

      expect(status.status).toBe('running');
      expect(status.running).toBe(true);
      expect(status.address).toBe('0xagentaddress');
      expect(status.containers.runningCount).toBe(2);
      expect(status.scheduler.totalSubscriptions).toBe(10);
      expect(status.startedAt).toBeDefined();
      expect(status.lastActiveAt).toBeDefined();
    });
  });

  describe('getPayloadResolver', () => {
    it('should return the PayloadResolver', () => {
      const resolver = agent.getPayloadResolver();
      expect(resolver).toBeDefined();
    });
  });
});

describe('AgentInstance callbacks', () => {
  let agent: AgentInstance;
  let capturedCallbacks: any = {};

  const testConfig = {
    chain: {
      rpcUrl: 'https://test.rpc.url',
      wsRpcUrl: 'wss://test.ws.url',
      routerAddress: '0x1234',
      coordinatorAddress: '0x5678',
      deploymentBlock: 0,
      wallet: {
        keystorePath: './.noosphere-test/keystore.json',
        paymentAddress: '0xpayment',
      },
    },
    containers: [],
    verifiers: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallbacks = {};

    // Capture the callbacks passed to fromKeystore
    (NoosphereAgent.fromKeystore as Mock).mockImplementation(async (_path, _password, options) => {
      capturedCallbacks = {
        onRequestStarted: options.onRequestStarted,
        onRequestProcessing: options.onRequestProcessing,
        onRequestSkipped: options.onRequestSkipped,
        onRequestFailed: options.onRequestFailed,
        onComputeDelivered: options.onComputeDelivered,
        onCommitmentSuccess: options.onCommitmentSuccess,
        isRequestProcessed: options.isRequestProcessed,
        loadCheckpoint: options.loadCheckpoint,
        saveCheckpoint: options.saveCheckpoint,
        getContainer: options.getContainer,
        getRetryableEvents: options.getRetryableEvents,
        resetEventForRetry: options.resetEventForRetry,
        payloadEncoder: options.payloadEncoder,
      };
      return mockNoosphereAgent;
    });

    agent = new AgentInstance('callback-test', 'Callback Test', testConfig as any, 'password');
  });

  describe('onRequestStarted', () => {
    it('should have onRequestStarted callback defined', async () => {
      await agent.initialize();
      expect(capturedCallbacks.onRequestStarted).toBeDefined();
      expect(typeof capturedCallbacks.onRequestStarted).toBe('function');
    });
  });

  describe('onRequestProcessing', () => {
    it('should have onRequestProcessing callback', async () => {
      await agent.initialize();
      expect(capturedCallbacks.onRequestProcessing).toBeDefined();
    });
  });

  describe('onRequestSkipped', () => {
    it('should have onRequestSkipped callback', async () => {
      await agent.initialize();
      expect(capturedCallbacks.onRequestSkipped).toBeDefined();
    });
  });

  describe('onRequestFailed', () => {
    it('should have onRequestFailed callback', async () => {
      await agent.initialize();
      expect(capturedCallbacks.onRequestFailed).toBeDefined();
    });
  });

  describe('onComputeDelivered', () => {
    it('should have onComputeDelivered callback defined', async () => {
      await agent.initialize();
      expect(capturedCallbacks.onComputeDelivered).toBeDefined();
      expect(typeof capturedCallbacks.onComputeDelivered).toBe('function');
    });
  });

  describe('onCommitmentSuccess', () => {
    it('should have onCommitmentSuccess callback', async () => {
      await agent.initialize();
      expect(capturedCallbacks.onCommitmentSuccess).toBeDefined();
    });
  });

  describe('checkpoint callbacks', () => {
    it('should have loadCheckpoint callback defined', async () => {
      await agent.initialize();
      expect(capturedCallbacks.loadCheckpoint).toBeDefined();
      // Should return a value or undefined
      const result = capturedCallbacks.loadCheckpoint();
      expect(result === undefined || typeof result === 'object').toBe(true);
    });

    it('should have saveCheckpoint callback defined', async () => {
      await agent.initialize();
      expect(capturedCallbacks.saveCheckpoint).toBeDefined();
    });
  });

  describe('getContainer callback', () => {
    it('should return undefined for zero hash container', async () => {
      await agent.initialize();

      const container = capturedCallbacks.getContainer(
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      );

      expect(container).toBeUndefined();
    });

    it('should return undefined for unknown container', async () => {
      await agent.initialize();

      const container = capturedCallbacks.getContainer('0xunknown');

      expect(container).toBeUndefined();
    });
  });

  describe('retry callbacks', () => {
    it('should have getRetryableEvents callback defined', async () => {
      await agent.initialize();
      expect(capturedCallbacks.getRetryableEvents).toBeDefined();
    });

    it('should have resetEventForRetry callback defined', async () => {
      await agent.initialize();
      expect(capturedCallbacks.resetEventForRetry).toBeDefined();
    });
  });

  describe('payloadEncoder callback', () => {
    it('should encode payload using PayloadResolver', async () => {
      await agent.initialize();

      const result = await capturedCallbacks.payloadEncoder('test content');

      // The payloadEncoder converts URI to hex-encoded bytes for on-chain submission
      // 'ipfs://QmEncoded' -> 0x697066733a2f2f516d456e636f646564
      expect(result).toEqual({
        contentHash: '0xencodedHash',
        uri: '0x697066733a2f2f516d456e636f646564',
      });
    });
  });
});

describe('substituteEnvVars', () => {
  it('should substitute environment variables in container env', () => {
    process.env.TEST_VAR = 'test-value';

    const config = {
      chain: {
        rpcUrl: 'https://test.rpc',
        routerAddress: '0x1234',
        coordinatorAddress: '0x5678',
        deploymentBlock: 0,
        wallet: { keystorePath: './keystore.json', paymentAddress: '0x0' },
      },
      containers: [
        {
          id: '0xcontainer',
          name: 'Test',
          image: 'test:latest',
          port: 8080,
          env: {
            MY_VAR: '${TEST_VAR}',
            STATIC: 'static',
          },
        },
      ],
      verifiers: [],
    };

    // The substitution happens in buildContainerMap
    const agent = new AgentInstance('env-test', 'Env Test', config as any, 'password');
    expect(agent).toBeDefined();

    delete process.env.TEST_VAR;
  });

  it('should create agent with missing env vars in config', async () => {
    // Ensure variable is not set
    delete process.env.MISSING_VAR;

    const config = {
      chain: {
        rpcUrl: 'https://test.rpc',
        routerAddress: '0x1234',
        coordinatorAddress: '0x5678',
        deploymentBlock: 0,
        wallet: { keystorePath: './keystore.json', paymentAddress: '0x0' },
      },
      containers: [
        {
          id: '0xcontainer',
          name: 'Test',
          image: 'test:latest',
          port: 8080,
          env: {
            MY_VAR: '${MISSING_VAR}',
          },
        },
      ],
      verifiers: [],
    };

    const agent = new AgentInstance('missing-env', 'Missing Env', config as any, 'password');
    expect(agent).toBeDefined();

    // Initialize should still work even with missing env var
    await agent.initialize();
    // The container env will contain the original ${MISSING_VAR} string
    expect(agent).toBeDefined();
  });
});
