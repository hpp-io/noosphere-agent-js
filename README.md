# Noosphere Agent

A Noosphere agent with web dashboard for running decentralized compute tasks.

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

## Web Dashboard

- **Main page** (`/`) - Agent status, containers, verifiers
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

**Container Environment:**
| Variable | Description |
|----------|-------------|
| `LLMROUTER_API_KEY` | LLM Router API key (for LLM container) |
| `LLMROUTER_BASE_URL` | LLM Router base URL |
| `GEMINI_API_KEY` | Google Gemini API key |

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
| `ar://` | Arweave permanent storage | Permanent archival |

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
npm run generate:config # Generate config from registry
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
