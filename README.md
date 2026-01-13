# Noosphere Agent

A Noosphere agent with web dashboard for running decentralized compute tasks.

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
  "containers": [
    {
      "id": "0x2fe108c896fbbc20874ff97c7f230c6d06da1e60e731cbedae60125468f8333a",
      "name": "noosphere-hello-world",
      "image": "ghcr.io/hpp-io/example-hello-world-noosphere:latest",
      "port": "8081"
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
