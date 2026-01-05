/**
 * Configuration Loader
 *
 * Loads configuration from config.json and merges with environment variables.
 * Secrets (private keys, passwords) are always loaded from .env for security.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

export interface AgentConfig {
  chain: {
    enabled: boolean;
    rpcUrl: string;
    wsRpcUrl: string | null;
    routerAddress: string;
    coordinatorAddress: string;
    deploymentBlock: number;
    processingInterval: number;
    wallet: {
      keystorePath: string;
      paymentAddress: string;
    };
  };
  scheduler: {
    enabled: boolean;
    cronIntervalMs: number;
    syncPeriodMs: number;
    maxRetryAttempts: number;
  };
  containers: Array<{
    id: string;
    image: string;
    port: string;
    env?: Record<string, string>;
  }>;
  verifiers?: Array<{
    id: string;
    name: string;
    address: string;
    requiresProof?: boolean;
    proofService?: {
      image: string;
      port: string;
      command?: string;
      env?: Record<string, string>;
      requirements?: {
        gpu?: boolean;
        memory?: string;
        cpu?: number;
      };
    };
    verified?: boolean;
    description?: string;
  }>;
}

export interface RuntimeConfig extends AgentConfig {
  // Secrets from .env (never stored in config.json)
  secrets: {
    keystorePassword: string;
    privateKey?: string;
  };
}

let cachedConfig: RuntimeConfig | null = null;

/**
 * Load configuration from config.json and merge with .env secrets
 */
export function loadConfig(configPath?: string): RuntimeConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const path = configPath || join(process.cwd(), 'config.json');

  try {
    // Load config.json
    const configData = readFileSync(path, 'utf-8');
    const config: AgentConfig = JSON.parse(configData);

    // Load secrets from environment variables
    const keystorePassword = process.env.KEYSTORE_PASSWORD;
    if (!keystorePassword) {
      throw new Error('KEYSTORE_PASSWORD environment variable is required');
    }

    // Build runtime config
    const runtimeConfig: RuntimeConfig = {
      ...config,
      secrets: {
        keystorePassword,
        privateKey: process.env.PRIVATE_KEY,
      },
    };

    // Cache the config
    cachedConfig = runtimeConfig;

    return runtimeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Configuration file not found: ${path}\n` +
          'Please create config.json or specify a custom path.'
      );
    }
    throw error;
  }
}

/**
 * Get cached config (throws if not loaded)
 */
export function getConfig(): RuntimeConfig {
  if (!cachedConfig) {
    throw new Error('Configuration not loaded. Call loadConfig() first.');
  }
  return cachedConfig;
}

/**
 * Clear cached config (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}
