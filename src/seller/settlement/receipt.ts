/**
 * Receipt settlement handler (M2b, design 02 §6.2).
 *
 * For services with `receipt: true` the seller owns the settlement order:
 *   verify (402 challenge handled by the gate) → run container → settle
 *   (obtain the on-chain tx) → build an execution receipt → respond.
 *
 * The receipt (bridge `buildExecutionReceipt`) deterministically binds the
 * advertised PaymentRequirements + settle tx + request/result hashes, so the
 * buyer — or any third party — can verify what the payment bought. This is the
 * direct-mode substitute for an on-chain verifier.
 *
 * Failure semantics: compute error → 502 before settle (buyer not charged);
 * settle error after compute → forward the gate's error response, job recorded
 * `completed` with `settle_failed` (work done, payment not captured).
 */

import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { ExpressAdapter } from '@x402/express';
import { buildExecutionReceipt } from '@hpp-io/x402-mcp-bridge/receipt';
import type { SellerServiceEntry } from '../types';
import type { ContainerMeta, ContainerRunner, SellerJobsDb, SellerLogger } from '../deps';

/** Narrow gate surface (x402HTTPResourceServer) — injectable for tests. */
export interface ReceiptPaymentGate {
  processHTTPRequest(ctx: {
    adapter: ExpressAdapter;
    path: string;
    method: string;
    paymentHeader?: string;
  }): Promise<any>;
  processSettlement(
    paymentPayload: unknown,
    paymentRequirements: unknown,
    declaredExtensions: unknown,
    resultCtx: unknown,
  ): Promise<any>;
}

export interface ReceiptHandlerDeps {
  gate: ReceiptPaymentGate;
  /** Resolves when the gate has fetched /supported (lazy init). */
  gateReady: Promise<void>;
  runner: ContainerRunner;
  container: ContainerMeta;
  db: SellerJobsDb;
  log: SellerLogger;
  asset?: string;
  timeoutMs?: number;
}

function decodeB64Json(v: unknown): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(String(v), 'base64').toString('utf-8'));
  } catch {
    return {};
  }
}

function sendGateResponse(res: Response, response: { status: number; headers?: Record<string, string>; body?: unknown; isHtml?: boolean }): void {
  res.status(response.status);
  for (const [k, v] of Object.entries(response.headers ?? {})) res.setHeader(k, v);
  if (response.isHtml) res.send(response.body);
  else res.json(response.body ?? {});
}

export function makeReceiptHandler(svc: SellerServiceEntry, deps: ReceiptHandlerDeps) {
  return async function receiptHandler(req: Request, res: Response): Promise<void> {
    await deps.gateReady;

    // 402 challenge + facilitator verify — the gate builds a version-correct
    // challenge and validates the buyer's signature.
    const context = {
      adapter: new ExpressAdapter(req),
      path: req.path,
      method: req.method,
      paymentHeader: req.header('payment-signature') || req.header('x-payment'),
    };
    const result = await deps.gate.processHTTPRequest(context);
    if (result.type === 'payment-error') {
      sendGateResponse(res, result.response);
      return;
    }
    if (result.type !== 'payment-verified') {
      res.status(500).json({ error: `unexpected gate result: ${result.type}` });
      return;
    }
    const { paymentPayload, paymentRequirements, declaredExtensions } = result;
    const payer: string | undefined =
      (paymentPayload as any)?.payload?.authorization?.from ?? (paymentPayload as any)?.payload?.from;

    const jobId = randomUUID();
    deps.db.saveSellerJob({
      job_id: jobId,
      service: svc.name,
      settlement: 'direct',
      network: svc.network,
      scheme: (paymentPayload as any)?.scheme ?? svc.schemes[0],
      payer,
      amount: svc.x402Price,
      asset: deps.asset,
      status: 'running',
    });

    // Run the container (payment verified but NOT yet settled).
    let output: string;
    try {
      ({ output } = await deps.runner.runContainer(deps.container, JSON.stringify(req.body ?? {}), deps.timeoutMs));
    } catch (err) {
      const message = (err as Error).message;
      deps.log.error(`[x402-seller] compute failed for ${svc.name} (job ${jobId}): ${message}`);
      deps.db.updateSellerJob(jobId, { status: 'failed', error_message: message });
      res.status(502).json({ jobId, error: 'compute_failed' }); // not settled ⇒ not charged
      return;
    }

    // Settle NOW so the tx hash exists before we respond.
    const body = { jobId, service: svc.name, output };
    const settle = await deps.gate.processSettlement(paymentPayload, paymentRequirements, declaredExtensions, {
      request: context,
      responseBody: Buffer.from(JSON.stringify(body)),
      responseHeaders: {},
    });
    if (!settle.success) {
      deps.log.error(`[x402-seller] settle failed for ${svc.name} (job ${jobId})`);
      deps.db.updateSellerJob(jobId, { status: 'completed', output, error_message: 'settle_failed' });
      sendGateResponse(res, settle.response);
      return;
    }
    for (const [k, v] of Object.entries(settle.headers ?? {})) res.setHeader(k, String(v));
    // 2.14: ProcessSettleSuccessResponse extends SettleResponse — transaction/
    // payer live on the result itself; the header decode is only a fallback.
    const settleInfo = decodeB64Json(settle.headers?.['payment-response'] ?? settle.headers?.['x-payment-response']);
    const transaction = String(settle.transaction ?? settleInfo.transaction ?? '');

    const receipt = buildExecutionReceipt({
      requirements: paymentRequirements,
      transaction,
      capability: { skillId: svc.name, request: req.body ?? {}, result: body },
      payer: (settle.payer as string | undefined) ?? (settleInfo.payer as string | undefined) ?? payer ?? null,
      sellerServiceId: svc.name,
      settledAt: new Date().toISOString(),
    });

    deps.db.updateSellerJob(jobId, { status: 'settled', output, settle_tx: transaction || undefined });
    res.status(200).json({ ...body, receipt });
  };
}
