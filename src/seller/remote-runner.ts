/**
 * x402 Seller — external-aware container runner.
 *
 * Routes containers declared with `externalUrl` (already running on another
 * host, e.g. over the tailnet) straight over HTTP and delegates everything
 * else to the local runner (agent-core ContainerManager). Mirrors
 * ContainerManager.runContainer's request/response contract exactly, so a
 * container app cannot tell whether it is being called locally or remotely.
 */

import axios from 'axios';
import type { ContainerMeta, ContainerRunner } from './deps';

const DEFAULT_TIMEOUT_MS = 180_000;
const CONNECTION_RETRIES = 5;
const CONNECTION_RETRY_DELAY_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same output extraction as agent-core ContainerManager. */
function extractOutput(data: unknown): string {
  if (typeof data === 'string') return data;
  const obj = data as { output?: unknown };
  if (obj && obj.output !== undefined) {
    return typeof obj.output === 'string' ? obj.output : JSON.stringify(obj.output);
  }
  return JSON.stringify(data);
}

export interface ExternalRunnerOptions {
  connectionRetries?: number;
  connectionRetryDelayMs?: number;
}

export class ExternalAwareRunner implements ContainerRunner {
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly local: ContainerRunner,
    opts: ExternalRunnerOptions = {},
  ) {
    this.retries = opts.connectionRetries ?? CONNECTION_RETRIES;
    this.retryDelayMs = opts.connectionRetryDelayMs ?? CONNECTION_RETRY_DELAY_MS;
  }

  async runContainer(
    container: ContainerMeta,
    input: string,
    timeout: number = DEFAULT_TIMEOUT_MS,
  ): Promise<{ output: string }> {
    if (!container.externalUrl) {
      return this.local.runContainer(container, input, timeout);
    }

    const url = `${container.externalUrl.replace(/\/+$/, '')}/computation`;

    // Same body shape as agent-core: parsed input fields merged over { input }.
    let requestBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(input);
      requestBody = { input, ...parsed };
    } catch {
      requestBody = { input };
    }

    let lastError: any;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        const response = await axios.post(url, requestBody, {
          timeout,
          headers: { 'Content-Type': 'application/json' },
        });
        return { output: extractOutput(response.data) };
      } catch (error: any) {
        lastError = error;
        if (error.code === 'ECONNREFUSED' && attempt < this.retries) {
          await sleep(this.retryDelayMs);
          continue;
        }
        break;
      }
    }

    if (lastError.response) {
      throw new Error(
        `Container HTTP error ${lastError.response.status}: ${JSON.stringify(lastError.response.data)}`,
      );
    }
    if (lastError.code === 'ECONNREFUSED') {
      throw new Error(
        `Cannot connect to external container at ${url} after ${this.retries} attempts. Is it running?`,
      );
    }
    if (lastError.code === 'ETIMEDOUT' || lastError.code === 'ECONNABORTED') {
      throw new Error(`Container execution timeout after ${timeout}ms`);
    }
    throw lastError;
  }
}
