# Noosphere Agent

A Noosphere agent with web dashboard for running decentralized compute tasks —
and, optionally, **selling your compute per-call for USDC.e via [x402](https://docs.x402.org)**
(see [Sell Your Compute](#-sell-your-compute-x402)).

Built with [@noosphere/sdk](https://www.npmjs.com/package/@noosphere/sdk) packages:
- `@noosphere/agent-core` - Event monitoring, container execution, payload resolution
- `@noosphere/contracts` - Type-safe contract interfaces
- `@noosphere/crypto` - Keystore and wallet management
- `@noosphere/registry` - Container and verifier discovery

## Prerequisites

- Node.js >= 18.0.0
- Docker >= 20.10.0
- Funded wallet with ETH for gas fees

## Quick Start

### 1. Install

```bash
git clone https://github.com/hpp-io/noosphere-agent-js.git
cd noosphere-agent-js
npm install
```

### 2. Configure

```bash
# Generate config from registry (recommended)
npm run generate:config

# Or copy template manually
cp config.example.json config.json
cp .env.example .env
```

Edit `.env`:
```bash
KEYSTORE_PASSWORD=your-secure-password
PAYMENT_ADDRESS=0xYourPaymentWalletAddress
```

### 3. Initialize Keystore

```bash
npm run init
```

This creates an encrypted keystore and displays your agent address and payment wallet address. Update `PAYMENT_ADDRESS` in `.env` with the displayed payment wallet.

### 4. Fund Wallets

Send testnet ETH to:
1. **Agent EOA** - for gas fees (address shown after init)
2. **Payment Wallet** - receives compute fees (address shown after init)

### 5. Run

```bash
# Start agent
npm run agent

# Open dashboard (optional, in separate terminal)
npm run dev
```

- Agent API: http://localhost:4000
- Dashboard: http://localhost:3000

## 💰 Sell Your Compute (x402)

Turn any container this agent runs into a **paid API**. Buyers pay per call in
USDC.e over HTTP or MCP; the public HPP facilitator verifies and settles the
payment on-chain to your wallet. No smart contracts to deploy, no subscriptions
to create, no gas needed on your side — you only receive.

```
buyer ── POST /paid/compute/<service> ──▶ your agent
          402 → sign → retry (automatic)      │ runs your container locally
          ◀── 200 { output } ─────────────────┘ payment settles to your payTo
```

### Quick start — 3 commands

```bash
npm run generate:config -- --all --seller   # config + a paid service per container
npm run init                                # create keystore (shows your addresses)
npm run agent                               # paid routes are live
```

Your services are now live at `POST /paid/compute/<service>` (HTTP) and as
`compute_<service>` tools at `/mcp` (MCP, works with Claude Desktop via
[`@hpp-io/x402-mcp-bridge`](https://www.npmjs.com/package/@hpp-io/x402-mcp-bridge)).

Or add the block to `config.json` by hand:

```jsonc
"x402Seller": {
  "enabled": true,
  "payTo": "0xYourReceivingWallet",          // defaults to wallet.paymentAddress
  "facilitators": { "eip155:181228": "https://facilitator-sepolia.hpp.io" },
  "defaultAsset": {
    "eip155:181228": {
      "address": "0x401eCb1D350407f13ba348573E5630B83638E30D",   // USDC.e
      "extra": { "name": "Bridged USDC", "version": "2" }
    }
  },
  "services": [
    {
      "name": "sentiment",                    // → POST /paid/compute/sentiment
      "containerId": "hf-sentiment",          // an id from containers[]
      "settlement": "direct",
      "network": "eip155:181228",
      "schemes": ["exact"],
      "x402Price": "5000",                    // atomic USDC.e: 5000 = $0.005/call
      "inputSchema": {                        // validated BEFORE payment
        "type": "object", "required": ["text"],
        "properties": { "text": { "type": "string" } }
      },
      "receipt": true,                        // include a verifiable execution receipt
      "description": "Sentiment analysis, per call"
    }
  ]
}
```

### Sell your own model

A sellable container needs exactly one endpoint:

```
POST /computation   { "input": "<raw>", ...buyer JSON }  →  { "output": "<string>" }
```

That's the whole contract — payment, validation, and job tracking are the
agent's problem. **[examples/hf-sentiment](./examples/hf-sentiment)** wraps a
HuggingFace model in ~30 lines and walks the full path in ~10 minutes.

### How buyers pay

Any x402 client works. With [`@x402/fetch`](https://www.npmjs.com/package/@x402/fetch):

```ts
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const client = new x402Client().register("eip155:181228", new ExactEvmScheme(account));
const paidFetch = wrapFetchWithPayment(fetch, client);

const r = await paidFetch("https://your-host/paid/compute/sentiment", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "I love this" }),
});
// → { jobId, service, output, receipt? }
```

MCP buyers connect to `/mcp` (StreamableHTTP) or `/mcp/sse` and call
`compute_<service>` — payment happens transparently via `@x402/mcp`.

### Fairness & safety (what the buyer can rely on)

- **Invalid input → HTTP 400 before payment.** Your `inputSchema` gates the
  request; the buyer is never charged for a call your container can't serve.
- **Compute failure → no charge.** Settlement only happens after a successful
  response.
- **`receipt: true` → verifiable execution receipt** in the response body: a
  deterministic hash binding of the advertised price, the on-chain settle tx,
  and the request/result. Anyone can re-derive it.
- **You never custody funds.** Payments move buyer → `payTo` directly on-chain;
  the agent holds no keys that can spend them.

### Get discovered

Every paid route advertises [bazaar discovery metadata](https://docs.x402.org)
in its 402 — after your first settled sale the HPP discovery indexer lists you
automatically. To appear **before** your first sale, register explicitly:

```jsonc
"x402Seller": {
  "discovery": {
    "enabled": true,
    "apiUrl": "https://x402-discovery.hpp.io",
    "publicBaseUrl": "https://your-public-host.example.com",  // buyers reach you here
    "register": true    // requires payTo to be the agent's keystore EOA
  }
}
```

`publicBaseUrl` is your responsibility in production (your domain / tunnel).
For **local testing only**, `"demoTunnel": true` starts a Cloudflare Quick
Tunnel and fills it in automatically (ephemeral URL, never for production;
needs `cloudflared` installed).

### Seller dashboard

Open the web dashboard (`npm run dev`) and hit **x402 Seller** — earnings,
settle success rate, per-service stats, wallet balances, and a live feed of
paid jobs. Raw data: `GET /api/seller/{summary,wallets,services,jobs,earnings}`.

## Web Dashboard

- **Main page** (`/`) - Agent status, containers, verifiers
- **x402 Seller** (`/seller`) - Paid-call earnings, services, jobs feed
- **History** (`/history`) - Request history with fees and profit tracking

## Docker Deployment

```bash
# Build and run
npm run docker:build
npm run docker:up

# View logs
npm run docker:logs

# Stop
npm run docker:down
```

## Configuration

### Generate from Registry

```bash
# Interactive mode
npm run generate:config

# List available containers
npm run generate:config -- --list

# Add specific containers
npm run generate:config -- --containers noosphere-hello-world,noosphere-llm
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `KEYSTORE_PASSWORD` | Password for encrypted keystore |
| `PAYMENT_ADDRESS` | Payment wallet address |
| `PROOF_SERVICE_PRIVATE_KEY` | For verifiers with proof service (optional) |

**Payload Storage (S3/R2):**

| Variable | Description |
|----------|-------------|
| `R2_ENDPOINT` | S3-compatible endpoint URL |
| `R2_BUCKET` | Bucket name |
| `R2_ACCESS_KEY_ID` | Access key ID |
| `R2_SECRET_ACCESS_KEY` | Secret access key |
| `R2_PUBLIC_URL_BASE` | Public URL base for downloads |
| `R2_REGION` | Region (default: auto) |
| `R2_KEY_PREFIX` | Optional key prefix |

**Payload Storage (IPFS/Pinata):**

| Variable | Description |
|----------|-------------|
| `PINATA_API_KEY` | Pinata API key |
| `PINATA_API_SECRET` | Pinata API secret |
| `IPFS_GATEWAY` | IPFS gateway URL |
| `IPFS_API_URL` | IPFS API URL (for local node) |

### Config File (`config.json`)

```json
{
  "chain": {
    "enabled": true,
    "rpcUrl": "https://sepolia.hpp.io",
    "wsRpcUrl": "wss://sepolia.hpp.io",
    "routerAddress": "0x31B0d4038b65E2c17c769Bad1eEeA18EEb1dBdF6",
    "coordinatorAddress": "0x5e055cd47E5d16f3645174Cfe2423D61fe8F4585",
    "deploymentBlock": 7776,
    "processingInterval": 5000,
    "wallet": {
      "keystorePath": "./.noosphere/keystore.json",
      "paymentAddress": "0xYourPaymentWallet"
    }
  },
  "payload": {
    "uploadThreshold": 1024,
    "defaultStorage": "s3"
  },
  "containerExecution": {
    "timeout": 180000,
    "connectionRetries": 3,
    "connectionRetryDelayMs": 1000
  },
  "containers": [
    {
      "id": "0x2fe108c896fbbc20874ff97c7f230c6d06da1e60e731cbedae60125468f8333a",
      "name": "noosphere-hello-world",
      "image": "ghcr.io/hpp-io/example-hello-world-noosphere:latest",
      "port": "8081"
    },
    {
      "id": "0x4548979e884d5d80117fbed9525e85279935318bdb71f8b73894cf7230686e93",
      "name": "noosphere-llm",
      "image": "ghcr.io/hpp-io/example-llm-noosphere:latest",
      "port": "8082",
      "env": {
        "LLMROUTER_API_KEY": "${LLMROUTER_API_KEY}",
        "GEMINI_API_KEY": "${GEMINI_API_KEY}"
      }
    }
  ],
  "verifiers": [
    {
      "id": "immediate-finalize-verifier",
      "name": "Immediate Finalize Verifier",
      "address": "0x672c325941E3190838523052ebFF122146864EAd",
      "requiresProof": false
    }
  ],
  "scheduler": {
    "enabled": true,
    "cronIntervalMs": 60000,
    "syncPeriodMs": 3000
  },
  "retry": {
    "maxRetries": 3,
    "retryIntervalMs": 30000
  }
}
```

Use `${VAR_NAME}` syntax for sensitive values - they are substituted at runtime from environment variables.

For the optional `x402Seller` block (sell compute per-call), see
[Sell Your Compute (x402)](#-sell-your-compute-x402) above — a full example
lives in [config.example.json](./config.example.json).

## PayloadData (Large Input/Output Handling)

The agent supports URI-based payload resolution for handling large inputs and outputs without storing them on-chain.

### How It Works

```
┌─────────────────┐     ┌─────────────┐     ┌─────────────────┐
│  Client         │     │  On-chain   │     │  Agent          │
│                 │     │             │     │                 │
│ 1. Upload to    │     │ PayloadData │     │ 3. Fetch from   │
│    IPFS/R2      │────▶│ {           │────▶│    IPFS/R2      │
│                 │     │   hash,     │     │                 │
│ 2. Send URI     │     │   uri       │     │ 4. Process      │
│    on-chain     │     │ }           │     │                 │
└─────────────────┘     └─────────────┘     └─────────────────┘
```

### Supported URI Schemes

| Scheme | Description | Use Case |
|--------|-------------|----------|
| `data:` | Inline base64-encoded | Small payloads (< threshold) |
| `ipfs://` | IPFS content addressing | Decentralized storage |
| `https://` | HTTP(S) URLs | R2, S3, any HTTP storage |

### Configuration

```json
{
  "payload": {
    "uploadThreshold": 1024,
    "defaultStorage": "s3"
  }
}
```

- `uploadThreshold`: Size in bytes above which outputs are uploaded to external storage (default: 1024)
- `defaultStorage`: Where to upload large outputs - `"s3"` (R2/S3), `"ipfs"`, or `"data"` (inline)

### Storage Options

**S3/R2 (Recommended for outputs):**
- Fast, reliable, cost-effective
- Requires: `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_URL_BASE`

**IPFS/Pinata (Common for inputs):**
- Decentralized, content-addressed
- Requires: `PINATA_API_KEY`, `PINATA_API_SECRET`, `IPFS_GATEWAY`

## Useful Commands

```bash
npm run agent           # Start agent
npm run dev             # Start dashboard (dev mode)
npm run generate:config # Generate config from registry (--seller for x402 selling)
npm run init            # Initialize keystore
npm run send:request    # Send test request
npm test                # Run tests
```

## Troubleshooting

**Agent won't start**
- Check `.env` file exists with `KEYSTORE_PASSWORD`
- Ensure Docker is running
- Verify `config.json` exists

**No requests received**
- Check dashboard for agent status
- Verify wallet has sufficient ETH for gas

**Container errors**
- Check port conflicts in `config.json`
- View logs: `docker logs noosphere-<container-name>`

## License

MIT
