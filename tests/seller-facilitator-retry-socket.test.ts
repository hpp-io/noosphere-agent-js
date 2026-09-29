import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { RetryingFacilitatorClient } from '../src/seller/facilitator-client';

// 실제로 소켓이 끊기는 상황을 재현한다 — 운영에서 본 증상(첫 settle 이 fetch failed)과 같은 층위.
// 수정 전(HTTPFacilitatorClient)은 그대로 throw 하고, 수정 후는 재시도해 정상 응답을 받는지 대조한다.
let dropped = 0;
const server = http.createServer((req, res) => {
  if (dropped === 0) {                       // 첫 요청만 응답 없이 연결을 끊는다
    dropped++;
    req.socket.destroy();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true, transaction: '0xdeadbeef', network: 'eip155:181228', payer: '0x0' }));
});
const url = await new Promise<string>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const payload = { x402Version: 1, scheme: 'exact', network: 'eip155:181228', payload: {} } as never;
const requirements = { scheme: 'exact', network: 'eip155:181228' } as never;

describe('연결이 끊긴 settle', () => {
  it('수정 전: fetch failed 가 그대로 올라온다', async () => {
    dropped = 0;
    await expect(new HTTPFacilitatorClient({ url }).settle(payload, requirements)).rejects.toThrow(/fetch failed/i);
  });

  it('수정 후: 재시도해서 정산 응답을 받는다', async () => {
    dropped = 0;
    const c = new RetryingFacilitatorClient({ url }, { baseDelayMs: 10 });
    await expect(c.settle(payload, requirements)).resolves.toMatchObject({ success: true, transaction: '0xdeadbeef' });
  });
});
