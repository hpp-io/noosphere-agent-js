import { describe, it, expect } from 'vitest';
import { JsonRpcProvider, WebSocketProvider } from 'ethers';
import { WebSocketServer } from 'ws';
import { EpochManager } from '../src/services/epoch-manager';

const VRF_CONFIG = { enabled: true, vrfAddress: '0x' + '1'.repeat(40), vrngContainerUrl: 'http://localhost:1' };
const HTTP_RPC = 'http://127.0.0.1:1';

const createProvider = (em: EpochManager) =>
  (em as unknown as { createProvider(): Promise<JsonRpcProvider | WebSocketProvider> }).createProvider();

describe('EpochManager provider selection', () => {
  it('uses HTTP when no ws url is configured', async () => {
    const em = new EpochManager(VRF_CONFIG, HTTP_RPC, undefined);
    const p = await createProvider(em);
    expect(p).toBeInstanceOf(JsonRpcProvider);
    expect(p).not.toBeInstanceOf(WebSocketProvider);
  });

  it('falls back to HTTP when the ws endpoint rejects (used to hang boot forever)', async () => {
    // Nothing listens on port 9; connection is refused immediately — before
    // the fix, the first RPC call over this provider awaited indefinitely.
    const em = new EpochManager(VRF_CONFIG, HTTP_RPC, 'ws://127.0.0.1:9');
    const p = await createProvider(em);
    expect(p).toBeInstanceOf(JsonRpcProvider);
    expect(p).not.toBeInstanceOf(WebSocketProvider);
  }, 15_000);

  it('keeps the ws provider when the endpoint answers', async () => {
    // Minimal JSON-RPC-over-ws endpoint: answer eth_chainId so getNetwork resolves.
    const server = new WebSocketServer({ port: 0 });
    server.on('connection', (sock) => {
      sock.on('message', (raw) => {
        const req = JSON.parse(String(raw));
        sock.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: '0x1' }));
      });
    });
    const port = (server.address() as { port: number }).port;
    try {
      const em = new EpochManager(VRF_CONFIG, HTTP_RPC, `ws://127.0.0.1:${port}`);
      const p = await createProvider(em);
      expect(p).toBeInstanceOf(WebSocketProvider);
      await (p as WebSocketProvider).destroy();
    } finally {
      server.close();
    }
  }, 15_000);
});
