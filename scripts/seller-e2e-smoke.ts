/**
 * Seller M1 smoke test — real @x402 middleware against a live facilitator.
 *
 * Proves the direct-settlement route negotiates a correct 402 challenge with a
 * REAL facilitator (default local stack :4022, override with FACILITATOR_URL).
 * Does NOT perform on-chain settlement (that needs a funded buyer + running
 * container — the full L5 e2e). This closes the integration between our seller
 * wiring and the facilitator's /supported.
 *
 *   FACILITATOR_URL=http://localhost:4022 npx tsx scripts/seller-e2e-smoke.ts
 */
import express from 'express';
import { SellerService } from '../src/seller';
import type { SellerJobsDb } from '../src/seller/deps';

const PORT = Number(process.env.SMOKE_PORT ?? 4099);
const NETWORK = process.env.SMOKE_NETWORK ?? 'eip155:181228';
const FACILITATOR = process.env.FACILITATOR_URL ?? 'http://localhost:4022';
const USDCE = process.env.USDCE_ADDRESS ?? '0x401eCb1D350407f13ba348573E5630B83638E30D';

const noopDb: SellerJobsDb = {
  saveSellerJob: () => {}, updateSellerJob: () => {},
  getSellerJobs: () => [], getSellerEarnings: () => [],
};
const noopRunner = { runContainer: async () => ({ output: 'smoke' }) };

async function main() {
  const seller = new SellerService(
    {
      enabled: true,
      payTo: '0x26907E00A0Bf7C6F3F26f1a9dA089E6f2fEd4f21',
      facilitators: { [NETWORK]: FACILITATOR },
      defaultAsset: { [NETWORK]: { address: USDCE, extra: { name: 'Bridged USDC', version: '2' } } },
      services: [
        {
          name: 'llm', containerId: '0xabc', settlement: 'direct', network: NETWORK, schemes: ['exact'],
          x402Price: '10000', description: 'smoke llm',
          inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
        },
      ],
    },
    {
      containers: new Map([['0xabc', { id: '0xabc', name: 'llm', image: 'img', tag: 'latest', port: '8082' }]]),
      runner: noopRunner,
      db: noopDb,
      logger: { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) },
    },
  );

  await seller.initialize();
  const app = express();
  app.use(express.json());
  seller.mount(app);
  const server = app.listen(PORT);
  await new Promise((r) => server.once('listening', r));
  console.log(`\n[smoke] seller on :${PORT}, facilitator=${FACILITATOR}\n`);

  let failed = false;
  const check = (name: string, ok: boolean, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };

  // 1) catalog
  const cat = await fetch(`http://localhost:${PORT}/paid/catalog`).then((r) => r.json());
  check('GET /paid/catalog lists llm', cat.services?.[0]?.name === 'llm', `payTo=${cat.payTo}`);

  // 2a) invalid input → 400 BEFORE payment (inputSchema guard)
  const bad = await fetch(`http://localhost:${PORT}/paid/compute/llm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x' }),
  });
  const badBody: any = await bad.json().catch(() => ({}));
  check('invalid input → 400 (pre-payment)', bad.status === 400 && badBody.error === 'invalid_input', `status=${bad.status}`);

  // 2b) 402 challenge (valid input, no payment) — exercises real facilitator /supported
  const res = await fetch(`http://localhost:${PORT}/paid/compute/llm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }),
  });
  check('POST /paid/compute/llm → 402 (payment required)', res.status === 402, `status=${res.status}`);
  if (res.status === 402) {
    const raw = await res.text();
    let body: any = {};
    try { body = JSON.parse(raw); } catch { /* not json */ }
    if (process.env.SMOKE_DEBUG) {
      console.log('    402 headers:', JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2));
      console.log('    402 raw body:', raw.slice(0, 400));
    }
    // x402 v2 may carry the challenge in a header instead of the body.
    const hdr = res.headers.get('payment-required') || res.headers.get('www-authenticate') || res.headers.get('x-payment-required');
    if ((!body.accepts && !body.paymentRequirements) && hdr) {
      try { body = JSON.parse(Buffer.from(hdr.replace(/^Bearer\s+/i, ''), 'base64').toString('utf-8')); } catch { /* */ }
    }
    const accepts = body.accepts ?? body.paymentRequirements ?? [];
    const a = Array.isArray(accepts) ? accepts[0] : undefined;
    check('402 advertises exact scheme on network', a?.scheme === 'exact' && a?.network === NETWORK, JSON.stringify(a));
    const amount = String(a?.maxAmountRequired ?? a?.price?.amount ?? a?.amount ?? a?.maxAmount ?? '');
    check('402 advertises our payTo + price', !!a?.payTo?.toLowerCase().includes('26907e') && amount === '10000', `payTo=${a?.payTo} amount=${amount}`);
  } else {
    console.log('    response:', await res.text().catch(() => ''));
  }

  server.close();
  console.log(`\n[smoke] ${failed ? 'FAIL' : 'PASS'}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[smoke] error:', e?.message ?? e); process.exit(1); });
