/**
 * x402 Seller — MCP transport.
 *
 * Mirrors the paid HTTP routes one-to-one as MCP tools: each direct service
 * becomes `compute_<name>`. Payment uses the standard @x402/mcp wrapper
 * (serve-then-settle: the SDK settles after the handler returns a successful
 * result; `isError` results cancel payment — buyer not charged).
 *
 * Transports (same endpoints as noosphere-x402-server):
 *   /mcp          StreamableHTTP (modern; mcp-remote / Claude Desktop default)
 *   /mcp/sse      legacy SSE + /mcp/messages POST channel
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { createPaymentWrapper, extractPaymentFromMeta, x402ResourceServer } from '@x402/mcp';
import type { FacilitatorClient } from '@x402/core/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import type { Network } from '@x402/core/types';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';

import { compileInputValidators } from './validate-input';
import { synthesizeExample } from './routes';
import type { SellerServiceEntry, X402SellerAssetConfig } from './types';
import type { ContainerMeta, ContainerRunner, SellerJobsDb, SellerLogger } from './deps';

export interface McpMountDeps {
  app: Express;
  services: SellerServiceEntry[];
  containers: Map<string, ContainerMeta>;
  runner: ContainerRunner;
  db: SellerJobsDb;
  log: SellerLogger;
  payTo: string;
  facilitators: Record<string, string>;
  defaultAsset: Record<string, X402SellerAssetConfig>;
  timeoutMs?: number;
  baseUrl?: string;
  /** Test override — prebuilt facilitator clients instead of HTTP ones. */
  facilitatorClients?: FacilitatorClient[];
}

interface PreparedTool {
  name: string;
  svc: SellerServiceEntry;
  container: ContainerMeta;
  accepts: Awaited<ReturnType<x402ResourceServer['buildPaymentRequirements']>>;
  extensions: Record<string, unknown>;
}

export async function mountSellerMcp(deps: McpMountDeps): Promise<{ tools: string[] }> {
  const direct = deps.services.filter((s) => s.settlement === 'direct');
  if (direct.length === 0) return { tools: [] };

  // One facilitator client per distinct URL; the resource server routes each
  // network's verify/settle to the matching client.
  let clients = deps.facilitatorClients;
  if (!clients) {
    const seen = new Map<string, FacilitatorClient>();
    for (const svc of direct) {
      const url = deps.facilitators[svc.network];
      if (!url) throw new Error(`x402Seller: no facilitator URL configured for network "${svc.network}"`);
      if (!seen.has(url)) seen.set(url, new HTTPFacilitatorClient({ url }));
    }
    clients = Array.from(seen.values());
  }

  const rs = new x402ResourceServer(clients);
  for (const net of new Set(direct.map((s) => s.network))) {
    rs.register(net as Network, new ExactEvmScheme());
  }
  await rs.initialize();

  const validators = compileInputValidators(direct);

  const prepared: PreparedTool[] = [];
  for (const svc of direct) {
    const container = deps.containers.get(svc.containerId);
    if (!container) {
      deps.log.error(`[x402-seller] mcp: no container metadata for "${svc.containerId}" (service ${svc.name}) — skipped`);
      continue;
    }
    const asset = deps.defaultAsset[svc.network];
    if (!asset) throw new Error(`x402Seller: no defaultAsset configured for network "${svc.network}"`);

    const accepts = await rs.buildPaymentRequirements({
      scheme: 'exact',
      network: svc.network as Network,
      payTo: deps.payTo,
      price: { amount: svc.x402Price, asset: asset.address, extra: { ...(asset.extra ?? {}) } },
      maxTimeoutSeconds: 600,
    });

    const extensions = {
      ...declareDiscoveryExtension({
        toolName: `compute_${svc.name}`,
        description: svc.description,
        // Must match what we actually mount below (StreamableHTTPServerTransport
        // on /mcp). Advertising 'sse' sent buyers that honor the declaration to
        // the wrong transport, and discovery stores whatever the settlement's
        // bazaar block said — so the first payment for a tool rewrote its listing
        // to 'sse' and made it unreachable from then on.
        transport: 'streamable-http',
        // Describe what a CALLER passes, not what the container consumes. The
        // tool signature below is `{ args }` — same payload as the HTTP body,
        // one level down — so a declaration of the bare service schema tells an
        // agent the wrong shape, and it has no other way to learn the wrapper.
        inputSchema: {
          type: 'object',
          properties: {
            args: svc.inputSchema ?? { type: 'object', additionalProperties: true },
          },
          // `args` is optional in the tool signature (services that take no
          // input are called bare), so the declaration says the same.
          additionalProperties: false,
        },
        // A concrete, valid call — the same example the HTTP listing declares,
        // wrapped the way this transport takes it.
        example: { args: svc.discovery?.input ?? synthesizeExample(svc.inputSchema) },
        output: svc.discovery?.output?.example !== undefined
          ? { example: svc.discovery.output.example }
          : { example: { jobId: 'uuid', service: svc.name, output: '<string>' } },
      }),
    };

    prepared.push({ name: svc.name, svc, container, accepts, extensions });
  }

  const buildServer = (): McpServer => {
    const mcp = new McpServer({ name: 'noosphere-agent-seller', version: '0.1.0' });

    for (const { name, svc, container, accepts, extensions } of prepared) {
      // Settle-tx attribution: the settlement hook fires right after a
      // successful handler for the same call; a FIFO per tool correlates the
      // jobId. (Concurrent same-tool calls could swap txs between two jobs'
      // dashboard rows — metadata only, payment-correctness unaffected.)
      const pendingJobs: string[] = [];

      // NOTE: keep this an http(s) URL whenever possible (set
      // x402Seller.discovery.publicBaseUrl). The bazaar discovery extractor
      // derives `new URL(u).origin`, which is the literal "null" for
      // non-special schemes like mcp:// — corrupting indexed listings.
      const paid = createPaymentWrapper(rs, {
        accepts,
        resource: {
          url: `${deps.baseUrl ?? 'mcp://noosphere-agent'}/mcp/tools/compute_${name}`,
          description: svc.description,
          mimeType: 'application/json',
        },
        extensions,
        hooks: {
          onAfterSettlement: (ctx) => {
            const jobId = pendingJobs.shift();
            const tx = (ctx.settlement as { transaction?: string }).transaction;
            if (jobId) deps.db.updateSellerJob(jobId, { status: 'settled', settle_tx: tx });
          },
        },
      });

      mcp.tool(
        `compute_${name}`,
        svc.description ?? `Run ${container.name} compute, paid per call`,
        { args: z.record(z.unknown()).optional() },
        paid(async (input, ctx) => {
          const args = (input.args ?? {}) as Record<string, unknown>;

          // Same ajv gate as HTTP: invalid input returns isError, which
          // CANCELS payment (verified but never settled) — buyer not charged.
          const validate = validators.get(name);
          if (validate && !validate(args)) {
            const details = (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
            return { content: [{ type: 'text' as const, text: `invalid input: ${details}` }], isError: true };
          }

          const paymentPayload = extractPaymentFromMeta({
            name: ctx.toolName,
            arguments: ctx.arguments as Record<string, unknown>,
            _meta: ctx.meta as Record<string, unknown> | undefined,
          });
          const payer = (paymentPayload?.payload as { authorization?: { from?: string } } | undefined)
            ?.authorization?.from;

          const jobId = randomUUID();
          deps.db.saveSellerJob({
            job_id: jobId,
            service: name,
            settlement: 'direct',
            network: svc.network,
            scheme: (paymentPayload as { scheme?: string } | undefined)?.scheme ?? 'exact',
            payer,
            amount: svc.x402Price,
            asset: deps.defaultAsset[svc.network]?.address,
            status: 'running',
          });

          try {
            const { output } = await deps.runner.runContainer(container, JSON.stringify(args), deps.timeoutMs);
            deps.db.updateSellerJob(jobId, { status: 'completed', output });
            pendingJobs.push(jobId); // settled by onAfterSettlement
            return { content: [{ type: 'text' as const, text: JSON.stringify({ jobId, service: name, output }) }] };
          } catch (err) {
            const message = (err as Error).message;
            deps.log.error(`[x402-seller] mcp compute failed for ${name} (job ${jobId}): ${message}`);
            deps.db.updateSellerJob(jobId, { status: 'failed', error_message: message });
            return { content: [{ type: 'text' as const, text: 'compute_failed' }], isError: true };
          }
        }),
      );
    }
    return mcp;
  };

  // ---- Transports --------------------------------------------------------
  const { app } = deps;

  const httpTransports = new Map<string, StreamableHTTPServerTransport>();
  app.all('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    let transport = sessionId ? httpTransports.get(sessionId) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { httpTransports.set(sid, transport!); },
      });
      transport.onclose = () => {
        if (transport!.sessionId) httpTransports.delete(transport!.sessionId);
      };
      await buildServer().connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });

  const sseTransports = new Map<string, SSEServerTransport>();
  app.get('/mcp/sse', async (_req: Request, res: Response) => {
    const transport = new SSEServerTransport('/mcp/messages', res);
    sseTransports.set(transport.sessionId, transport);
    res.on('close', () => sseTransports.delete(transport.sessionId));
    await buildServer().connect(transport);
  });
  app.post('/mcp/messages', async (req: Request, res: Response) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const transport = sseTransports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: 'unknown sessionId' });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  const tools = prepared.map((p) => `compute_${p.name}`);
  deps.log.info(`[x402-seller] mcp mounted — /mcp (+/mcp/sse), tools: ${tools.join(', ')}`);
  return { tools };
}
