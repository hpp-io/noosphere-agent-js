// Agent types
export type AgentStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

export interface AgentInstanceStatus {
  id: string;
  name?: string;
  status: AgentStatus;
  address?: string;
  running: boolean;
  containers: {
    runningCount: number;
  };
  scheduler: {
    totalSubscriptions: number;
    activeSubscriptions: number;
    pendingTransactions: number;
  };
  error?: string;
  startedAt?: number;
  lastActiveAt?: number;
}

export interface AgentManagerStatus {
  totalAgents: number;
  runningAgents: number;
  agents: AgentInstanceStatus[];
}

// Config types
export interface ChainConfig {
  rpcUrl: string;
  wsRpcUrl?: string;
  routerAddress: string;
  coordinatorAddress: string;
  deploymentBlock: number;
  wallet: {
    keystorePath: string;
    paymentAddress: string;
  };
}

export interface ContainerConfig {
  id: string;
  name?: string;
  image: string;
  port: string;
  env?: Record<string, string>;
}

export interface VerifierConfig {
  id: string;
  name: string;
  requiresProof?: boolean;
  proofService?: {
    image: string;
    port: string;
    env?: Record<string, string>;
    command?: string[];
  };
}

export interface SchedulerConfig {
  enabled?: boolean;
  cronIntervalMs?: number;
  syncPeriodMs?: number;
}

export interface RetryConfig {
  maxRetries?: number;      // Maximum retry attempts for failed requests (default: 3)
  retryIntervalMs?: number; // Interval to check for retryable events (default: 30000ms)
}

export interface AgentConfigFile {
  chain: ChainConfig;
  containers?: ContainerConfig[];
  verifiers?: VerifierConfig[];
  scheduler?: SchedulerConfig;
  retry?: RetryConfig;
  logging?: {
    level?: string;
  };
}

export interface AgentInstanceConfig {
  id: string;
  name?: string;
  configPath: string;
  keystorePassword: string;
  enabled?: boolean;
}
