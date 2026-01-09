/**
 * Configuration Loader
 *
 * Loads configuration from config.json and merges with environment variables.
 * Secrets (private keys, passwords) are always loaded from .env for security.
 *
 * Supports ${ENV_VAR} syntax in config values for environment variable substitution.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Recursively substitute ${ENV_VAR} patterns in config values
 */
function substituteEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    // Replace ${VAR_NAME} with environment variable value
    return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        console.warn(`Warning: Environment variable ${varName} is not set`);
        return match; // Keep the placeholder if not set
      }
      return value;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(item => substituteEnvVars(item));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVars(value);
    }
    return result;
  }
  return obj;
}

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
    const rawConfig = JSON.parse(configData);

    // Substitute ${ENV_VAR} patterns in config values
    const config: AgentConfig = substituteEnvVars(rawConfig);

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
