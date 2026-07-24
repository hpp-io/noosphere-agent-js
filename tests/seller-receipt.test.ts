import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeReceiptHandler } from '../src/seller/settlement/receipt';
import { buildExecutionReceipt } from '@hpp-io/x402-mcp-bridge/receipt';
import type { SellerServiceEntry } from '../src/seller/types';
import type { ContainerMeta } from '../src/seller/deps';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const svc: SellerServiceEntry = {
  name: 'sentiment', containerId: 'hf', settlement: 'direct',
  network: 'eip155:181228', x402Price: '1000', schemes: ['exact'], receipt: true,
};
const container: ContainerMeta = { id: 'hf', name: 'hf', image: 'img', tag: 'latest', port: '8090' };

const REQUIREMENTS = {
  scheme: 'exact', network: 'eip155:181228', amount: '1000',
  asset: '0xUSDCe', payTo: '0xPay', maxTimeoutSeconds: 600,
};

function mockReqRes(body: unknown) {
  const req: any = { body, path: '/paid/compute/sentiment', method: 'POST', header: () => undefined, headers: {} };
  const res: any = {
    statusCode: 200, headers: {} as Record<string, string>, body: undefined,
    status(c: number) { res.statusCode = c; return res; },
    json(b: unknown) { res.body = b; return res; },
    send(b: unknown) { res.body = b; return res; },
    setHeader(n: string, v: string) { res.headers[n.toLowerCase()] = v; },
  };
  return { req, res };
}

function verifiedGate(over: Partial<{ settleSuccess: boolean }> = {}) {
  return {
    processHTTPRequest: vi.fn().mockResolvedValue({
      type: 'payment-verified',
      paymentPayload: { scheme: 'exact', payload: { authorization: { from: '0xBuyer' } } },
      paymentRequirements: REQUIREMENTS,
      declaredExtensions: {},
    }),
    // Real 2.14 shape: ProcessSettleSuccessResponse extends SettleResponse —
    // transaction/payer are on the result itself (headers may not carry them).
    processSettlement: vi.fn().mockResolvedValue(
      over.settleSuccess === false
        ? { success: false, response: { status: 402, headers: {}, body: { error: 'settle failed' } } }
        : { success: true, transaction: '0xsettletx', payer: '0xBuyer', network: 'eip155:181228', headers: {} },
    ),
  };
}

describe('makeReceiptHandler (M2b)', () => {
  let db: any;
  beforeEach(() => { db = { saveSellerJob: vi.fn(), updateSellerJob: vi.fn() }; });

  const deps = (gate: any, runner: any) => ({
    gate, gateReady: Promise.resolve(), runner, container, db, log: noopLogger, asset: '0xUSDCe',
  });

  it('verify → run → settle → responds with a verifiable receipt', async () => {
    const gate = verifiedGate();
    const runner = { runContainer: vi.fn().mockResolvedValue({ output: 'POSITIVE (0.99)' }) };
    const { req, res } = mockReqRes({ text: 'great' });

    await makeReceiptHandler(svc, deps(gate, runner) as any)(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.output).toBe('POSITIVE (0.99)');
    const receipt = res.body.receipt;
    expect(receipt).toMatchObject({
      version: '1',
      payer: '0xBuyer',
      sellerServiceId: 'sentiment',
      settlement: { transaction: '0xsettletx', amount: '1000', network: 'eip155:181228' },
      capability: { skillId: 'sentiment' },
    });

    // Third-party verifiability: rebuilding from the same bindings yields the
    // same digests (receipt is deterministic given settledAt).
    const rebuilt = buildExecutionReceipt({
      requirements: REQUIREMENTS as any,
      transaction: '0xsettletx',
      capability: { skillId: 'sentiment', request: { text: 'great' }, result: { jobId: res.body.jobId, service: 'sentiment', output: 'POSITIVE (0.99)' } },
      payer: '0xBuyer', sellerServiceId: 'sentiment', settledAt: receipt.settlement.settledAt,
    });
    expect(rebuilt.receiptId).toBe(receipt.receiptId);
    expect(rebuilt.capability.requestHash).toBe(receipt.capability.requestHash);
    expect(rebuilt.capability.resultHash).toBe(receipt.capability.resultHash);

    // settle happened BEFORE the response (tx already known) and job settled.
    expect(gate.processSettlement).toHaveBeenCalled();
    const statuses = db.updateSellerJob.mock.calls.map((c: any[]) => c[1].status);
    expect(statuses).toContain('settled');
  });

  it('forwards the 402 challenge untouched when unpaid', async () => {
    const gate = {
      processHTTPRequest: vi.fn().mockResolvedValue({
        type: 'payment-error',
        response: { status: 402, headers: { 'payment-required': 'abc' }, body: {} },
      }),
      processSettlement: vi.fn(),
    };
    const runner = { runContainer: vi.fn() };
    const { req, res } = mockReqRes({ text: 'x' });

    await makeReceiptHandler(svc, deps(gate, runner) as any)(req, res);

    expect(res.statusCode).toBe(402);
    expect(res.headers['payment-required']).toBe('abc');
    expect(runner.runContainer).not.toHaveBeenCalled();
    expect(db.saveSellerJob).not.toHaveBeenCalled();
  });

  it('compute failure → 502, settle never attempted (buyer not charged)', async () => {
    const gate = verifiedGate();
    const runner = { runContainer: vi.fn().mockRejectedValue(new Error('boom')) };
    const { req, res } = mockReqRes({ text: 'x' });

    await makeReceiptHandler(svc, deps(gate, runner) as any)(req, res);

    expect(res.statusCode).toBe(502);
    expect(gate.processSettlement).not.toHaveBeenCalled();
    const statuses = db.updateSellerJob.mock.calls.map((c: any[]) => c[1].status);
    expect(statuses).toContain('failed');
  });

  it('settle failure after compute → gate error forwarded, job completed+settle_failed', async () => {
    const gate = verifiedGate({ settleSuccess: false });
    const runner = { runContainer: vi.fn().mockResolvedValue({ output: 'ok' }) };
    const { req, res } = mockReqRes({ text: 'x' });

    await makeReceiptHandler(svc, deps(gate, runner) as any)(req, res);

    expect(res.statusCode).toBe(402);
    const last = db.updateSellerJob.mock.calls.at(-1)[1];
    expect(last).toMatchObject({ status: 'completed', error_message: 'settle_failed' });
    expect(res.body.receipt).toBeUndefined();
  });
});
