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
  connection?: {
    state: string;
    mode: 'websocket' | 'http_polling' | 'connecting';
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

export interface IpfsConfig {
  apiUrl?: string;            // IPFS API URL (default: http://localhost:5001)
  gateway?: string;           // IPFS Gateway URL (default: http://localhost:8080/ipfs/)
  pinataApiKey?: string;      // Pinata API key (preferred)
  pinataApiSecret?: string;   // Pinata API secret (preferred)
  apiKey?: string;            // Pinata API key (deprecated, use pinataApiKey)
  apiSecret?: string;         // Pinata API secret (deprecated, use pinataApiSecret)
}

export interface S3Config {
  endpoint?: string;        // S3-compatible endpoint (required for R2/MinIO)
  bucket: string;           // Bucket name
  region?: string;          // AWS region (default: 'auto' for R2)
  accessKeyId: string;      // Access key ID
  secretAccessKey: string;  // Secret access key
  publicUrlBase: string;    // Public URL base for generating accessible URLs
  keyPrefix?: string;       // Key prefix for organizing files (default: '')
  forcePathStyle?: boolean; // Use path-style URLs (required for MinIO)
}

export interface PayloadConfig {
  uploadThreshold?: number;                // Size in bytes to trigger auto-upload (default: 1024)
  defaultStorage?: 'ipfs' | 's3' | 'data'; // Default storage for large outputs (default: 'ipfs')
  ipfs?: IpfsConfig;                       // IPFS configuration
  s3?: S3Config;                           // S3-compatible storage configuration (R2, S3, MinIO)
}

export interface ContainerExecutionConfig {
  timeout?: number;              // Container execution timeout in ms (default: 300000 = 5 min)
  connectionRetries?: number;    // Number of connection retry attempts (default: 5)
  connectionRetryDelayMs?: number; // Delay between retries in ms (default: 3000)
}

export interface VRFConfig {
  enabled?: boolean;                  // Enable EpochManager service (default: false)
  vrfAddress: string;                 // NoosphereVRF contract address
  vrngContainerUrl: string;           // VRNG container HTTP endpoint (e.g. http://localhost:8085)
  autoRegisterEpoch?: boolean;        // Auto-register next epoch on EpochRunningLow (default: true)
  epochLowThreshold?: number;         // Register next epoch when remaining < N (default: 100)
  retryAttempts?: number;             // Retry attempts for failed operations (default: 3)
  retryDelayMs?: number;              // Delay between retries in ms (default: 10000)
  pollingIntervalMs?: number;         // Fallback polling interval for epoch check (default: 60000)
}

export interface VRFStatus {
  enabled: boolean;
  vrfAddress: string;
  currentEpoch: number;
  epochRemaining: number;
  epochSize: number;
  nextEpochRegistered: boolean;
  lastRegistrationTx?: string;
  lastRegistrationEpoch?: number;
  autoRegisterEnabled: boolean;
  vrfOwner?: string;
  isOwner?: boolean;
}

export interface AgentConfigFile {
  chain: ChainConfig;
  containers?: ContainerConfig[];
  verifiers?: VerifierConfig[];
  scheduler?: SchedulerConfig;
  retry?: RetryConfig;
  payload?: PayloadConfig;
  containerExecution?: ContainerExecutionConfig;
  vrf?: VRFConfig;
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
