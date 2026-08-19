import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { measuredAmount, makeJobSubmitHandler, makeJobStatusHandler, startJobPoller } from '../src/seller/settlement/job';
import type { AsyncJobsDb } from '../src/seller/settlement/job';
import type { SellerServiceEntry } from '../src/seller/types';

const svc: SellerServiceEntry = {
  name: 'stt-longform', containerId: 'hf-stt', settlement: 'direct',
  network: 'eip155:190415', x402Price: '360000', schemes: ['upto'],
  maxTimeoutSeconds: 10800, job: { perMinuteAtomic: '3000' },
};

function memDb(): AsyncJobsDb & { rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    saveAsyncJob(r) { rows.set(r.job_id, { ...r, status: 'queued', settle_attempts: 0 }); },
    updateAsyncJob(id, patch) { Object.assign(rows.get(id) ?? {}, patch); },
    getAsyncJob(id) { return rows.get(id); },
    listAsyncJobsByStatus(statuses) {
      return [...rows.values()].filter((r) => statuses.includes(String(r.status)));
    },
  };
}

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

const verifiedGate = (settleImpl?: () => Promise<unknown>) => ({
  processHTTPRequest: vi.fn().mockResolvedValue({
    type: 'payment-verified',
    paymentPayload: { scheme: 'upto', payload: { permit2Authorization: { owner: '0xBuyer' } } },
    paymentRequirements: { scheme: 'upto', amount: '360000', maxTimeoutSeconds: 10800 },
    declaredExtensions: {},
  }),
  processSettlement: vi.fn(settleImpl ?? (() => Promise.resolve({ settlement: { transaction: '0xtx' } }))),
});

function mockRes() {
  const res: any = { statusCode: 200, body: undefined, headers: {} };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.setHeader = (k: string, v: string) => (res.headers[k] = v);
  return res;
}

afterEach(() => vi.restoreAllMocks());

describe('measuredAmount', () => {
  it('bills ceil(minutes) × rate with a 1-minute floor and the max cap', () => {
    expect(measuredAmount(svc, 30).toString()).toBe('3000');      // <1min → 1min
    expect(measuredAmount(svc, 61).toString()).toBe('6000');      // 61s → 2min
    expect(measuredAmount(svc, 3600).toString()).toBe('180000');  // 1h
    expect(measuredAmount(svc, 999999).toString()).toBe('360000');// capped at max
  });
});

describe('job submit', () => {
  it('verifies, submits to the container, persists the payment, responds 202', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ jobId: 'cj1' }),
    }) as never;
    const db = memDb();
    const gate = verifiedGate();
    const handler = makeJobSubmitHandler(svc, {
      gate: gate as never, gateReady: Promise.resolve(),
      containerUrl: 'http://100.1.2.3:8095', db, log: noopLog,
    });
    const res = mockRes();
    await handler({ path: '/paid/compute/stt-longform', method: 'POST', header: () => 'sig', body: { audio_url: 'https://x/a.mp3' } } as never, res);
    expect(res.statusCode).toBe(202);
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.perMinuteAtomic).toBe('3000');
    const row = [...db.rows.values()][0];
    expect(row.container_job_id).toBe('cj1');
    expect(String(row.payment_json)).toContain('0xBuyer');
    expect(gate.processSettlement).not.toHaveBeenCalled(); // NOT settled at submit
  });

  it('rejects without persisting when the container refuses the job', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 400, json: () => Promise.resolve({ error: 'audio_url is required' }),
    }) as never;
    const db = memDb();
    const handler = makeJobSubmitHandler(svc, {
      gate: verifiedGate() as never, gateReady: Promise.resolve(),
      containerUrl: 'http://c', db, log: noopLog,
    });
    const res = mockRes();
    await handler({ path: '/p', method: 'POST', header: () => 'sig', body: {} } as never, res);
    expect(res.statusCode).toBe(400);
    expect(db.rows.size).toBe(0);
  });
});

describe('job poller', () => {
  it('settles the measured amount when the container completes', async () => {
    vi.useFakeTimers();
    const db = memDb();
    db.saveAsyncJob({
      job_id: 'j1', service: 'stt-longform', container_job_id: 'cj1',
      container_url: 'http://c', max_amount: '360000', per_minute_atomic: '3000',
      payment_json: '{"p":1}', requirements_json: '{"amount":"360000"}', extensions_json: '{}',
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ status: 'completed', durationS: 3600 }),
    }) as never;
    const gate = verifiedGate();
    const poller = startJobPoller({
      services: new Map([['stt-longform', svc]]),
      gates: new Map([['stt-longform', { gate: gate as never, ready: Promise.resolve() }]]),
      db, log: noopLog, intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(25);
    poller.stop();
    vi.useRealTimers();

    const row = db.rows.get('j1')!;
    expect(row.status).toBe('settled');
    expect(row.amount).toBe('180000'); // 1h × 3000/min — actual, not the max
    expect(row.settle_tx).toBe('0xtx');
    const requirements = (gate.processSettlement.mock.calls[0] as unknown[])[1] as { amount: string };
    expect(requirements.amount).toBe('180000');
  });

  it('marks failed jobs without settling (buyer not charged)', async () => {
    vi.useFakeTimers();
    const db = memDb();
    db.saveAsyncJob({
      job_id: 'j2', service: 'stt-longform', container_job_id: 'cj2',
      container_url: 'http://c', max_amount: '360000', per_minute_atomic: '3000',
      payment_json: '{}', requirements_json: '{}', extensions_json: '{}',
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ status: 'failed', error: 'audio too long' }),
    }) as never;
    const gate = verifiedGate();
    const poller = startJobPoller({
      services: new Map([['stt-longform', svc]]),
      gates: new Map([['stt-longform', { gate: gate as never, ready: Promise.resolve() }]]),
      db, log: noopLog, intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(25);
    poller.stop();
    vi.useRealTimers();

    expect(db.rows.get('j2')!.status).toBe('failed');
    expect(gate.processSettlement).not.toHaveBeenCalled();
  });
});

describe('job status route', () => {
  it('404s unknown ids and proxies the transcript for settled jobs', async () => {
    const db = memDb();
    db.saveAsyncJob({
      job_id: 'j3', service: 'stt-longform', container_job_id: 'cj3',
      container_url: 'http://c', max_amount: '360000', per_minute_atomic: '3000',
      payment_json: '{}', requirements_json: '{}', extensions_json: '{}',
    });
    db.updateAsyncJob('j3', { status: 'settled', amount: '9000', settle_tx: '0xt' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ text: '전사 결과' }),
    }) as never;
    const handler = makeJobStatusHandler(db);

    let res = mockRes();
    await handler({ params: { jobId: 'nope' } } as never, res);
    expect(res.statusCode).toBe(404);

    res = mockRes();
    await handler({ params: { jobId: 'j3' } } as never, res);
    expect(res.body.status).toBe('settled');
    expect(res.body.text).toBe('전사 결과');
    expect(res.body.settleTx).toBe('0xt');
  });
});

describe('job audio proxy', () => {
  it('streams settled audio and blocks unsettled jobs', async () => {
    const { makeJobAudioHandler } = await import('../src/seller/settlement/job');
    const db = memDb();
    db.saveAsyncJob({
      job_id: 'a1', service: 'tts-longform', container_job_id: 'ca1',
      container_url: 'http://c', max_amount: '360000', per_minute_atomic: '3000',
      payment_json: '{}', requirements_json: '{}', extensions_json: '{}',
    });
    const handler = makeJobAudioHandler(db);

    let res = mockRes();
    res.end = (b: Buffer) => ((res.body = b), res);
    await handler({ params: { jobId: 'a1' } } as never, res);
    expect(res.statusCode).toBe(409); // queued → no artifact yet

    db.updateAsyncJob('a1', { status: 'settled' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, headers: { get: () => 'audio/mpeg' },
      arrayBuffer: () => Promise.resolve(new Uint8Array([73, 68, 51]).buffer),
    }) as never;
    res = mockRes();
    res.end = (b: Buffer) => ((res.body = b), res);
    await handler({ params: { jobId: 'a1' } } as never, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(Buffer.from(res.body).toString('latin1')).toBe('ID3');
  });
});
