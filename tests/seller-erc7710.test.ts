import { describe, it, expect } from 'vitest';
import { x402ResourceServer } from '@x402/express';
import { acceptSpec, buildSellerRoutes, ERC7710_SCHEME } from '../src/seller/routes';
import type { SellerServiceEntry } from '../src/seller/types';

const svc = (schemes: string[]): SellerServiceEntry =>
  ({ name: 'hello', containerId: 'c', settlement: 'direct', network: 'eip155:181228', schemes, x402Price: '10000', maxTimeoutSeconds: 600 }) as never;
const opts = {
  payTo: '0x9Dc2A176Ca65D982854CDe9BE84Dc7028236ba2c',
  facilitators: { 'eip155:181228': 'https://f' },
  defaultAsset: { 'eip155:181228': { address: '0x401eCb1D350407f13ba348573E5630B83638E30D', extra: { name: 'USDC.e', version: '2' } } },
};

describe('erc7710 pseudo-scheme → exact accept with assetTransferMethod', () => {
  it('maps "erc7710" to an exact accept marked erc7710 and keeps the asset extra', () => {
    const a = acceptSpec(ERC7710_SCHEME, svc(['exact', 'erc7710']), opts.defaultAsset['eip155:181228'], opts.payTo);
    expect(a.scheme).toBe('exact');
    expect(a.price.extra).toEqual({ name: 'USDC.e', version: '2', assetTransferMethod: 'erc7710' });
    expect(a.maxTimeoutSeconds).toBe(600);
  });

  it('marks the plain exact accept eip3009 only when erc7710 is also offered (no change for existing sellers)', () => {
    expect(acceptSpec('exact', svc(['exact', 'erc7710']), opts.defaultAsset['eip155:181228'], opts.payTo).price.extra).toEqual({ name: 'USDC.e', version: '2', assetTransferMethod: 'eip3009' });
    expect(acceptSpec('exact', svc(['exact']), opts.defaultAsset['eip155:181228'], opts.payTo).price.extra).toEqual({ name: 'USDC.e', version: '2' });
    expect(acceptSpec('upto', svc(['upto', 'erc7710']), opts.defaultAsset['eip155:181228'], opts.payTo)).toMatchObject({ scheme: 'upto', price: { extra: { name: 'USDC.e', version: '2' } } });
  });

  it('advertises accepts in the seller\'s order: [exact(eip3009), exact(erc7710)]', () => {
    const routes: any = buildSellerRoutes([svc(['exact', 'erc7710'])], opts);
    const accepts = routes['POST /paid/compute/hello'].accepts;
    expect(accepts.map((a: any) => [a.scheme, a.price.extra.assetTransferMethod])).toEqual([['exact', 'eip3009'], ['exact', 'erc7710']]);
  });

  it('a delegation payload matches the erc7710 requirement, not the eip3009 one (core subset matching)', () => {
    // What the 402 carries after the facilitator's /supported enrichment.
    const base = { scheme: 'exact', network: 'eip155:181228', amount: '10000', asset: opts.defaultAsset['eip155:181228'].address, payTo: opts.payTo, maxTimeoutSeconds: 600 };
    const req3009 = { ...base, extra: { name: 'USDC.e', version: '2', assetTransferMethod: 'eip3009' } };
    const req7710 = { ...base, extra: { name: 'USDC.e', version: '2', assetTransferMethod: 'erc7710', facilitatorAddresses: ['0x050BC3f099f0489D89b94C46Fa7DcEDf8aD7C7E0'] } };
    const rs = new x402ResourceServer([]);
    const match = (accepted: unknown) => (rs as any).findMatchingRequirements([req3009, req7710], { x402Version: 2, accepted, payload: {} });
    expect(match(req7710)).toBe(req7710);
    expect(match(req3009)).toBe(req3009);
    // Without the explicit eip3009 marker the first accept would swallow the delegation payload:
    const unmarked = { ...base, extra: { name: 'USDC.e', version: '2' } };
    expect(match(req7710) === req7710).toBe(true);
    expect((rs as any).findMatchingRequirements([unmarked, req7710], { x402Version: 2, accepted: req7710, payload: {} })).toBe(unmarked);
  });
});
