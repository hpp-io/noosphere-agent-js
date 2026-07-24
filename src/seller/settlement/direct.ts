/**
 * Direct settlement handler.
 *
 * x402 payment (verified by the @x402/express middleware) → run the container
 * locally → return output. The middleware settles AFTER the handler returns a
 * <400 response (serve-then-settle), so:
 *   - compute failure ⇒ we return >=400 ⇒ the buyer is NOT charged.
 *   - success ⇒ middleware settles; we capture the settle tx from the
 *     PAYMENT-RESPONSE header via a response 'finish' hook.
 */

import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { SellerServiceEntry } from '../types';
import type { ContainerMeta, ContainerRunner, SellerJobsDb, SellerLogger } from '../deps';

export interface DirectHandlerDeps {
  runner: ContainerRunner;
  container: ContainerMeta;
  db: SellerJobsDb;
  log: SellerLogger;
  asset?: string;
  timeoutMs?: number;
}

/** Base64-decode an x402 header into an object; {} on failure. */
function decodeB64Json(v: unknown): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(String(v), 'base64').toString('utf-8'));
  } catch {
    return {};
  }
}

/** Best-effort payer + scheme from the incoming X-PAYMENT header. */
function readPayment(req: Request): { payer?: string; scheme?: string } {
  const header = req.header('x-payment') || req.header('payment-signature');
  if (!header) return {};
  const p = decodeB64Json(header);
  return {
    payer: p?.payload?.authorization?.from ?? p?.payload?.from,
    scheme: p?.scheme,
  };
}

export function makeDirectHandler(svc: SellerServiceEntry, deps: DirectHandlerDeps) {
  return async function directHandler(req: Request, res: Response): Promise<void> {
    const jobId = randomUUID();
    const { payer, scheme } = readPayment(req);

    deps.db.saveSellerJob({
      job_id: jobId,
      service: svc.name,
      settlement: 'direct',
      network: svc.network,
      scheme: scheme ?? svc.schemes[0],
      payer,
      amount: svc.x402Price,
      asset: deps.asset,
      status: 'running',
    });

    // After the middleware settles, capture the tx from PAYMENT-RESPONSE.
    let completed = false;
    res.on('finish', () => {
      if (!completed || res.statusCode >= 400) return;
      const settle = decodeB64Json(res.getHeader('payment-response') ?? res.getHeader('x-payment-response'));
      if (settle && settle.success) {
        deps.db.updateSellerJob(jobId, { status: 'settled', settle_tx: settle.transaction ?? undefined });
      }
    });

    try {
      const input = JSON.stringify(req.body ?? {});
      const { output } = await deps.runner.runContainer(deps.container, input, deps.timeoutMs);
      completed = true;
      deps.db.updateSellerJob(jobId, { status: 'completed', output });
      res.status(200).json({ jobId, service: svc.name, output });
    } catch (err) {
      const message = (err as Error).message;
      deps.log.error(`[x402-seller] compute failed for ${svc.name} (job ${jobId}): ${message}`);
      deps.db.updateSellerJob(jobId, { status: 'failed', error_message: message });
      // >=400 ⇒ middleware skips settle ⇒ buyer not charged.
      res.status(502).json({ jobId, error: 'compute_failed' });
    }
  };
}
