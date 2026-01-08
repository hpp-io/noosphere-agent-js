# Noosphere Agent (Next.js)

A production-ready Noosphere agent with built-in web dashboard for monitoring and managing decentralized compute tasks.

## Features

- 🔐 **Keystore-based Security** - Encrypted wallet storage, no raw private keys
- 📦 **Container Registry** - Automatic discovery of compute containers and verifiers
- ⚡ **Real-time Event Processing** - WebSocket + HTTP fallback for blockchain events
- 🔄 **Automatic Scheduler** - Handles subscription intervals and commitments
- 🐳 **Docker Integration** - Executes containerized workloads with automatic cleanup
- 📊 **Web Dashboard** - Real-time monitoring of agent status and earnings
- 💰 **Computing History** - Track all processed requests, fees, and profitability
- 🔐 **Verifier Support** - Integrated proof generation services

## Architecture

```
noosphere-agent-js/
├── agent/                  # TypeScript agent (development)
│   └── index.ts
├── run-agent.js           # Production agent entry point
├── app/                   # Next.js dashboard
│   ├── page.tsx          # Main dashboard
│   ├── history/          # Computing history page
│   └── api/              # API routes
├── lib/                   # Shared configuration
│   └── config.ts         # Config loader
├── scripts/              # Utility scripts
│   ├── init-keystore.ts  # Keystore initialization
│   └── send-test-request.ts
└── config.json           # Main configuration file
```

## Prerequisites

- **Node.js** >= 18.0.0
- **Docker** >= 20.10.0 (for container execution)
- **Noosphere Testnet** access or your own deployment
- **Funded wallet** with ETH for gas fees

## Quick Start

### 1. Installation

```bash
# Clone the repository
git clone https://github.com/hpp-io/noosphere-agent-js.git
cd noosphere-agent-js

# Install dependencies
npm install

# Copy configuration templates
cp config.example.json config.json
cp .env.example .env
```

### 2. Configuration

#### Edit `config.json`:

```json
{
  "chain": {
    "enabled": true,
    "rpcUrl": "https://sepolia.hpp.io",
    "wsRpcUrl": null,
    "routerAddress": "0x31B0d4038b65E2c17c769Bad1eEeA18EEb1dBdF6",
    "coordinatorAddress": "0x5e055cd47E5d16f3645174Cfe2423D61fe8F4585",
    "deploymentBlock": 7776,
    "processingInterval": 5000,
    "wallet": {
      "keystorePath": "./.noosphere/keystore.json",
      "paymentAddress": "0xYourPaymentWalletAddress"
    }
  },
  "scheduler": {
    "enabled": true,
    "cronIntervalMs": 60000,
    "syncPeriodMs": 3000,
    "maxRetryAttempts": 3
  },
  "containers": [
    {
      "id": "noosphere-hello-world",
      "image": "ghcr.io/hpp-io/example-hello-world-noosphere:latest",
      "port": "8081"
    }
  ],
  "verifiers": [
    {
      "id": "immediate-finalize-verifier",
      "name": "Immediate Finalize Verifier",
      "address": "0x672c325941E3190838523052ebFF122146864EAd",
      "requiresProof": true,
      "proofService": {
        "image": "ghcr.io/hpp-io/noosphere-proof-creator:dev",
        "port": "3001",
        "command": "npm start",
        "env": {
          "RPC_URL": "https://sepolia.hpp.io",
          "CHAIN_ID": "181228",
          "IMMEDIATE_FINALIZE_VERIFIER_ADDRESS": "0x672c325941E3190838523052ebFF122146864EAd",
          "PRIVATE_KEY": "your-proof-service-private-key"
        }
      }
    }
  ]
}
```

#### Edit `.env`:

```bash
# Keystore password (never commit this file!)
KEYSTORE_PASSWORD=your-secure-password-here
```

### 3. Initialize Keystore

Create your agent keystore with your private key:

```bash
npm run init:keystore
```

This will:
1. Prompt for your EOA private key
2. Create encrypted keystore at `./.noosphere/keystore.json`
3. Initialize payment wallet contracts
4. Display your agent address and payment wallet address

**Update `config.json`** with the displayed payment wallet address:
```json
{
  "chain": {
    "wallet": {
      "paymentAddress": "0xYourDisplayedPaymentWallet"
    }
  }
}
```

### 4. Fund Your Wallets

You need to fund two wallets:

1. **Agent EOA Wallet** (for gas fees):
   ```bash
   # Your EOA address is displayed after keystore initialization
   # Send testnet ETH to this address
   ```

2. **Payment Wallet** (for receiving fees):
   ```bash
   # Your payment wallet address is displayed after keystore initialization
   # This is automatically created by WalletFactory
   ```

### 5. Run the Agent

```bash
# Start the agent
npm run agent

# In a separate terminal, start the web dashboard
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the dashboard.

## Web Dashboard

The dashboard provides real-time monitoring:

### Main Dashboard (`/`)
- **Agent Status**: Running state, address, balance
- **Payment Wallets**: Wallet addresses and balances
- **Available Containers**: Registered compute containers with tags
- **Available Verifiers**: Registered verifiers with proof services
- **Container Registry Stats**: Total containers and verifiers

### Computing History (`/history`)
- **Request Timeline**: All processed requests with timestamps
- **Financial Tracking**: Fee earned, gas costs, net profit per request
- **Detailed View**: Click any row to see full request details
- **Input/Output Data**: View request inputs and computation results
- **Pagination**: Navigate through historical requests

## How It Works

### Event Processing Flow

```
1. User creates subscription → Router emits RequestStarted event
2. Agent listens for events (WebSocket or HTTP polling)
3. Scheduler manages subscription intervals and commitments
4. Agent executes compute container with request data
5. Container returns result and optional proof
6. Agent submits result to Coordinator contract
7. Coordinator verifies result (with verifier if configured)
8. Agent receives fee payment to payment wallet
```

### Scheduler Service

The built-in scheduler handles:
- **Subscription Sync**: Periodically fetches active subscriptions
- **Interval Commitments**: Commits to serving subscription intervals
- **Automatic Execution**: Triggers compute at committed intervals
- **Transaction Management**: Tracks pending transactions and retries

### Container Management

Containers are automatically:
- **Pulled** from registry on agent startup
- **Started** as persistent Docker containers
- **Executed** when requests arrive
- **Cleaned up** when agent stops

### Verifier Integration

When verifiers are configured:
- **Proof Service Containers** start automatically
- **Proofs** are generated alongside compute results
- **Verification** happens on-chain before finalization

## Configuration Reference

### Chain Configuration
| Field | Description | Example |
|-------|-------------|---------|
| `rpcUrl` | Blockchain RPC endpoint | `https://sepolia.hpp.io` |
| `wsRpcUrl` | WebSocket RPC endpoint (optional) | `wss://sepolia.hpp.io` |
| `routerAddress` | Router contract address | `0x31B0...` |
| `coordinatorAddress` | Coordinator contract address | `0x5e05...` |
| `deploymentBlock` | Start block for event replay | `7776` |
| `wallet.keystorePath` | Path to keystore file | `./.noosphere/keystore.json` |
| `wallet.paymentAddress` | Payment wallet address | `0xYour...` |

### Scheduler Configuration
| Field | Description | Default |
|-------|-------------|---------|
| `enabled` | Enable scheduler service | `true` |
| `cronIntervalMs` | Commitment generation interval | `60000` (1 min) |
| `syncPeriodMs` | Subscription sync period | `3000` (3 sec) |
| `maxRetryAttempts` | Max retries for failed transactions | `3` |

### Container Configuration
| Field | Description | Required |
|-------|-------------|----------|
| `id` | Unique container identifier | Yes |
| `image` | Docker image name | Yes |
| `port` | Container port | Yes |
| `env` | Environment variables | No |

### Verifier Configuration
| Field | Description | Required |
|-------|-------------|----------|
| `id` | Unique verifier identifier | Yes |
| `name` | Human-readable name | Yes |
| `address` | Verifier contract address | Yes |
| `requiresProof` | Whether proof generation is needed | No |
| `proofService` | Proof service configuration | If `requiresProof` is `true` |

## Monitoring & Troubleshooting

### Agent Logs

The agent outputs structured logs:

```
🚀 Starting Noosphere Agent from config.json...
✓ ABIs loaded
✓ Registry loaded: 3 containers, 1 verifiers
🔐 Loaded 1 proof service containers
✓ Agent initialized from keystore

🚀 Preparing 3 containers...
  ✓ ghcr.io/hpp-io/example-hello-world-noosphere:latest ready
  ✓ ghcr.io/hpp-io/example-llm-noosphere:latest ready
  ✓ Started persistent container noosphere-proof-service-immediate-finalize-verifier

✓ Noosphere Agent is running
📊 Total subscriptions in registry: 4
```

### Common Issues

#### Agent won't start

**Error**: `KEYSTORE_PASSWORD environment variable is required`
- **Solution**: Make sure `.env` file exists with `KEYSTORE_PASSWORD=your-password`

**Error**: `Docker is not available`
- **Solution**: Start Docker daemon: `sudo systemctl start docker` (Linux) or open Docker Desktop

**Error**: `Configuration file not found`
- **Solution**: Create `config.json` from `config.example.json`

#### No requests received

1. **Check subscription exists**:
   ```bash
   # View agent status in dashboard
   open http://localhost:3000
   ```

2. **Verify deployment block**:
   - Make sure `deploymentBlock` in `config.json` is before first subscription

3. **Check network connectivity**:
   - Verify RPC URL is accessible
   - Test WebSocket connection if configured

#### Container execution fails

**Error**: `ports are not available: bind: address already in use`
- **Solution**: Change container port in `config.json` to unused port

**Error**: `Failed to pull image`
- **Solution**: Verify image name and ensure you have network access to registry

#### Proof service issues

**Error**: `Proof service container not starting`
- **Solution**: Check proof service port doesn't conflict with other services
- **Solution**: Verify `PRIVATE_KEY` is set in proof service `env` configuration

### Checking Container Status

```bash
# List running containers
docker ps

# View container logs
docker logs noosphere-noosphere-hello-world

# View proof service logs
docker logs noosphere-proof-service-immediate-finalize-verifier
```

## Production Deployment

### Build for Production

```bash
# Build Next.js dashboard
npm run build

# Start agent and dashboard
npm run agent &
npm start
```

### Using PM2 (Recommended)

```bash
# Install PM2
npm install -g pm2

# Start agent
pm2 start run-agent.js --name noosphere-agent

# Start dashboard
pm2 start npm --name noosphere-dashboard -- start

# Save configuration
pm2 save

# Setup auto-restart on system boot
pm2 startup
```

### Docker Deployment

```dockerfile
FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application
COPY . .

# Build Next.js
RUN npm run build

# Expose dashboard port
EXPOSE 3000

# Start both agent and dashboard
CMD ["sh", "-c", "node run-agent.js & npm start"]
```

## Security Best Practices

- ✅ **Never commit** `.env` or `config.json` with real credentials
- ✅ **Backup keystore** file to secure offline storage
- ✅ **Use strong password** for keystore encryption (20+ characters)
- ✅ **Rotate credentials** regularly
- ✅ **Monitor wallet balances** to ensure sufficient gas funds
- ✅ **Review container images** before adding to configuration
- ✅ **Use separate wallets** for different environments (testnet/mainnet)

## Development

### Running in Development Mode

```bash
# Run TypeScript agent with auto-reload
npm run agent:legacy

# Run Next.js in dev mode
npm run dev
```

### Testing

#### Manual Request Test

```bash
# Send a single manual test request
npm run send:request

# View test request in history
open http://localhost:3000/history
```

#### Scheduler Service Test

Test the agent's automatic scheduler with interval-based subscriptions:

```bash
# Create a scheduled subscription (10-minute intervals)
npm run send:scheduled
```

This will:
- Create a subscription with 5 executions at 10-minute intervals
- Agent's SchedulerService automatically triggers requests every 10 minutes
- Total test duration: 50 minutes

**Monitor the scheduler**:
1. **Agent logs**: Watch for `"🔄 Starting commitment generation task..."`
2. **Dashboard**: Check "Active Subscriptions" and "Committed Intervals" at http://localhost:3000
3. **Computing History**: Requests appear every 10 minutes at http://localhost:3000/history

**Note**: Minimum interval is 10 minutes (600 seconds) on testnet.

### Adding Custom Containers

1. **Build your container** following Noosphere container specs
2. **Publish to registry** (GitHub Container Registry, Docker Hub, etc.)
3. **Add to config.json**:
   ```json
   {
     "containers": [
       {
         "id": "my-custom-container",
         "image": "ghcr.io/myorg/my-container:latest",
         "port": "8090",
         "env": {
           "MY_ENV_VAR": "value"
         }
       }
     ]
   }
   ```

## API Reference

### Agent Status API

```bash
GET /api/agent/status
```

Returns:
```json
{
  "agentAddress": "0xAbDaA7Ce...",
  "balance": "0.1234",
  "paymentWallets": [
    {
      "address": "0x13F09...",
      "balance": "0.5678"
    }
  ]
}
```

### Computing History API

```bash
GET /api/history?limit=10&offset=0
```

Returns:
```json
{
  "history": [
    {
      "requestId": "0x123...",
      "subscriptionId": "1",
      "containerId": "noosphere-hello-world",
      "timestamp": "2024-01-05T12:00:00Z",
      "txHash": "0xabc...",
      "blockNumber": 12345,
      "feeEarned": "1000000000",
      "gasFee": "200000",
      "input": "0x...",
      "output": "0x...",
      "isPenalty": false
    }
  ],
  "total": 100
}
```

## License

MIT License - see [LICENSE](LICENSE) file for details

