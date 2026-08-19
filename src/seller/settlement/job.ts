/**
 * Async job settlement (long-form compute, usage-based).
 *
 * Sync settlement modes hold the buyer's connection while the container
 * works — impossible for long-form audio. Job mode decouples them:
 *
 *   submit  POST /paid/compute/<svc>   verify (upto max) → container POST
 *           /jobs → persist the verified payment payload alongside the job →
 *           respond { jobId, status } immediately. NOT settled yet.
 *   poll    GET /paid/jobs/<jobId>     free (no payment middleware) — jobId
 *           is an unguessable bearer token.
 *   settle  a poller watches the container; on completion it settles the
 *           MEASURED amount (ceil(minutes) × perMinuteAtomic, capped at the
 *           authorized max). Failed jobs are simply never settled.
 *
 * This is not a custom deferred-settle protocol: it is the upto scheme's
 * authorize-max / settle-actual semantics on a job timeline. The buyer's
 * signature deadline is now + maxTimeoutSeconds (advertise hours for jobs);
 * the facilitator settles `requirements.amount` and rejects anything above
 * the authorized ceiling.
 */

import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { ExpressAdapter } from '@x402/express';
import type { SellerServiceEntry } from '../types';
import type { SellerLogger } from '../deps';
import type { ReceiptPaymentGate } from './receipt';

/** Async-job persistence surface (structurally satisfied by lib/db). */
export interface AsyncJobsDb {
  saveAsyncJob(row: {
    job_id: string;
    service: string;
    container_job_id: string;
    container_url: string;
    network?: string;
    scheme?: string;
    payer?: string;
    max_amount: string;
    per_minute_atomic: string;
    payment_json: string;
    requirements_json: string;
    extensions_json: string;
  }): void;
  updateAsyncJob(jobId: string, patch: {
    status?: string;
    duration_s?: number;
    amount?: string;
    settle_tx?: string;
    error?: string;
    settle_attempts?: number;
  }): void;
  getAsyncJob(jobId: string): Record<string, unknown> | undefined;
  listAsyncJobsByStatus(statuses: string[]): Array<Record<string, unknown>>;
}

export interface JobHandlerDeps {
  gate: ReceiptPaymentGate;
  gateReady: Promise<void>;
  /** Base URL of the (external) container that owns /jobs. */
  containerUrl: string;
  db: AsyncJobsDb;
  log: SellerLogger;
}

const SETTLE_MAX_ATTEMPTS = 5;

function perMinuteAtomic(svc: SellerServiceEntry): bigint {
  return BigInt(svc.job?.perMinuteAtomic ?? svc.x402Price);
}

/** ceil(duration/60) × rate, capped at the authorized max. */
export function measuredAmount(svc: SellerServiceEntry, durationS: number): bigint {
  const minutes = BigInt(Math.max(1, Math.ceil(durationS / 60)));
  const amount = minutes * perMinuteAtomic(svc);
  const max = BigInt(svc.x402Price);
  return amount > max ? max : amount;
}

export function makeJobSubmitHandler(svc: SellerServiceEntry, deps: JobHandlerDeps) {
  return async function jobSubmitHandler(req: Request, res: Response): Promise<void> {
    await deps.gateReady;

    const context = {
      adapter: new ExpressAdapter(req),
      path: req.path,
      method: req.method,
      paymentHeader: req.header('payment-signature') || req.header('x-payment'),
    };
    const result = await deps.gate.processHTTPRequest(context);
    if (result.type === 'payment-error') {
      res.status(result.response.status);
      for (const [k, v] of Object.entries(result.response.headers ?? {})) res.setHeader(k, String(v));
      res.json(result.response.body ?? {});
      return;
    }
    if (result.type !== 'payment-verified') {
      res.status(500).json({ error: `unexpected gate result: ${result.type}` });
      return;
    }
    const { paymentPayload, paymentRequirements, declaredExtensions } = result;
    const payer: string | undefined =
      (paymentPayload as any)?.payload?.permit2Authorization?.owner ??
      (paymentPayload as any)?.payload?.authorization?.from;

    // Submit to the container FIRST — if it rejects (bad URL, over caps), the
    // buyer walks away unsettled and uncharged.
    let containerJobId: string;
    try {
      const submit = await fetch(`${deps.containerUrl.replace(/\/+$/, '')}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.body ?? {}),
      });
      const body = (await submit.json()) as { jobId?: string; error?: string };
      if (!submit.ok || !body.jobId) {
        res.status(400).json({ error: body.error ?? `container rejected job (${submit.status})` });
        return;
      }
      containerJobId = body.jobId;
    } catch (err) {
      res.status(502).json({ error: `job submit failed: ${(err as Error).message}` });
      return;
    }

    const jobId = randomUUID().replace(/-/g, '');
    deps.db.saveAsyncJob({
      job_id: jobId,
      service: svc.name,
      container_job_id: containerJobId,
      container_url: deps.containerUrl,
      network: svc.network,
      scheme: (paymentPayload as any)?.scheme ?? svc.schemes[0],
      payer,
      max_amount: svc.x402Price,
      per_minute_atomic: perMinuteAtomic(svc).toString(),
      payment_json: JSON.stringify(paymentPayload),
      requirements_json: JSON.stringify(paymentRequirements),
      extensions_json: JSON.stringify(declaredExtensions ?? {}),
    });
    deps.log.info(`[x402-seller] job accepted — ${svc.name} job ${jobId} (container ${containerJobId}, payer ${payer ?? '?'})`);

    res.status(202).json({
      jobId,
      service: svc.name,
      status: 'queued',
      pollUrl: `/paid/jobs/${jobId}`,
      maxAmountAtomic: svc.x402Price,
      perMinuteAtomic: perMinuteAtomic(svc).toString(),
    });
  };
}

/** Free status route — no payment; jobId is the bearer secret. The transcript
 * itself stays in the container (results are its product and its TTL) — this
 * route proxies it through once the job is done, keeping the agent db small. */
export function makeJobStatusHandler(db: AsyncJobsDb) {
  return async function jobStatusHandler(req: Request, res: Response): Promise<void> {
    const row = db.getAsyncJob(String(req.params.jobId));
    if (!row) {
      res.status(404).json({ error: 'unknown jobId' });
      return;
    }
    let text: string | undefined;
    let resultNote: string | undefined;
    if (row.status === 'settled' || row.status === 'settle_failed') {
      try {
        const r = await fetch(
          `${String(row.container_url).replace(/\/+$/, '')}/jobs/${row.container_job_id}`,
        );
        if (r.ok) text = ((await r.json()) as { text?: string }).text;
        else resultNote = 'result expired (container TTL)';
      } catch {
        resultNote = 'result temporarily unavailable';
      }
    }
    res.json({
      jobId: row.job_id,
      service: row.service,
      status: row.status,
      ...(row.duration_s != null ? { durationS: row.duration_s } : {}),
      ...(row.amount ? { amountAtomic: row.amount } : {}),
      ...(row.settle_tx ? { settleTx: row.settle_tx } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(resultNote ? { resultNote } : {}),
      ...(row.error ? { error: row.error } : {}),
    });
  };
}

export interface JobPollerDeps {
  services: Map<string, SellerServiceEntry>;
  gates: Map<string, { gate: ReceiptPaymentGate; ready: Promise<void> }>;
  db: AsyncJobsDb;
  log: SellerLogger;
  intervalMs?: number;
}

/**
 * Watch pending jobs; settle the measured amount on completion. Runs the
 * check serially per tick — job volume is low and settles must not race.
 */
export function startJobPoller(deps: JobPollerDeps): { stop: () => void } {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const row of deps.db.listAsyncJobsByStatus(['queued', 'processing'])) {
        const svc = deps.services.get(String(row.service));
        const gateEntry = svc && deps.gates.get(svc.name);
        if (!svc || !gateEntry) continue;
        let state: { status?: string; durationS?: number; text?: string; error?: string };
        try {
          const r = await fetch(
            `${String(row.container_url).replace(/\/+$/, '')}/jobs/${row.container_job_id}`,
          );
          if (r.status === 404) {
            deps.db.updateAsyncJob(String(row.job_id), { status: 'failed', error: 'job lost by container' });
            continue;
          }
          state = (await r.json()) as typeof state;
        } catch {
          continue; // container unreachable — retry next tick
        }

        if (state.status === 'processing' && row.status !== 'processing') {
          deps.db.updateAsyncJob(String(row.job_id), { status: 'processing' });
        } else if (state.status === 'failed') {
          deps.db.updateAsyncJob(String(row.job_id), {
            status: 'failed',
            error: state.error ?? 'container job failed',
          });
          deps.log.info(`[x402-seller] job ${row.job_id} failed — not settled (buyer not charged)`);
        } else if (state.status === 'completed') {
          const durationS = Number(state.durationS ?? 0);
          const amount = measuredAmount(svc, durationS).toString();
          const requirements = { ...JSON.parse(String(row.requirements_json)), amount };
          try {
            await gateEntry.ready;
            const settle = await gateEntry.gate.processSettlement(
              JSON.parse(String(row.payment_json)),
              requirements,
              JSON.parse(String(row.extensions_json)),
              { path: `/paid/jobs/${row.job_id}`, method: 'GET' },
            );
            const tx = (settle as any)?.settlement?.transaction ?? (settle as any)?.transaction;
            deps.db.updateAsyncJob(String(row.job_id), {
              status: 'settled',
              duration_s: durationS,
              amount,
              settle_tx: tx,
            });
            deps.log.info(
              `[x402-seller] job ${row.job_id} settled — ${durationS}s → ${amount} atomic (tx ${tx ?? '?'})`,
            );
          } catch (err) {
            const attempts = Number(row.settle_attempts ?? 0) + 1;
            const terminal = attempts >= SETTLE_MAX_ATTEMPTS;
            deps.db.updateAsyncJob(String(row.job_id), {
              ...(terminal ? { status: 'settle_failed' } : {}),
              settle_attempts: attempts,
              duration_s: durationS,
              amount,
              error: (err as Error).message.slice(0, 300),
            });
            deps.log.error(
              `[x402-seller] job ${row.job_id} settle attempt ${attempts} failed: ${(err as Error).message}`,
            );
          }
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.intervalMs ?? 15_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
