/**
 * x402 Seller — runtime dependency interfaces.
 *
 * The seller module depends on these narrow interfaces (not concrete classes)
 * so it stays testable and decoupled from lib/db and @noosphere/agent-core.
 */

import type { SellerJobRecord } from '../../lib/db';

export interface SellerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/** Subset of AgentDatabase the seller module needs (structurally satisfied by lib/db). */
export interface SellerJobsDb {
  saveSellerJob(job: {
    job_id: string;
    service: string;
    settlement: string;
    network?: string;
    scheme?: string;
    payer?: string;
    amount?: string;
    asset?: string;
    status?: string;
  }): void;
  updateSellerJob(jobId: string, patch: {
    status?: string;
    output?: string;
    error_message?: string;
    settle_tx?: string;
    payer?: string;
  }): void;
  getSellerJobs(limit?: number): SellerJobRecord[];
  getSellerEarnings(): Array<{ service: string; calls: number; earnings: string }>;
}

/** Container to run — matches @noosphere/agent-core ContainerMetadata (fields we use). */
export interface ContainerMeta {
  id: string;
  name: string;
  image: string;
  tag: string;
  port: string;
}

/** Runs a container and returns its output. Satisfied by agent-core ContainerManager. */
export interface ContainerRunner {
  runContainer(container: ContainerMeta, input: string, timeout?: number): Promise<{ output: string }>;
}

export type { SellerJobRecord };
