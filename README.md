# Noosphere Agent (Next.js)

Next.js-based Noosphere agent that uses the `noosphere-sdk` to execute decentralized compute tasks.

## Features

- 🔐 **Keystore-based security** - No raw private keys
- 📦 **Container registry** - Automatic container discovery
- ⚡ **Real-time event listening** - WebSocket + HTTP fallback
- 🔄 **Event replay** - Never miss events during downtime
- 🐳 **Docker execution** - Run any containerized workload
- 📊 **Web dashboard** - Monitor agent status (Next.js)

## Architecture

```
noosphere-agent-js/
├── agent/              # Background agent process
│   └── index.ts        # Main agent entry point
├── app/                # Next.js dashboard
│   ├── layout.tsx
│   ├── page.tsx
│   └── globals.css
└── lib/                # Shared utilities
```

## Prerequisites

- Node.js >= 18.0.0
- Docker (for container execution)
- Noosphere keystore file

## Installation

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your configuration
nano .env
```

## Configuration

Edit `.env` with your settings:

```bash
# Keystore Configuration
KEYSTORE_PATH=./.noosphere/keystore.json
KEYSTORE_PASSWORD=your-secure-password

# Blockchain Configuration
RPC_URL=https://sepolia.infura.io/v3/YOUR_INFURA_KEY
WS_RPC_URL=wss://sepolia.infura.io/ws/v3/YOUR_INFURA_KEY

# Contract Addresses
ROUTER_ADDRESS=0x...
COORDINATOR_ADDRESS=0x...

# Optional: Start block for event replay
DEPLOYMENT_BLOCK=0
```

## First-Time Setup

### 1. Initialize Keystore

If you don't have a keystore yet:

```bash
# Create keystore initialization script
node -e "
const { KeystoreManager } = require('@noosphere/crypto');
const { ethers } = require('ethers');

async function init() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const privateKey = process.env.PRIVATE_KEY;

  await KeystoreManager.initialize(
    './.noosphere/keystore.json',
    process.env.KEYSTORE_PASSWORD,
    privateKey,
    provider
  );

  console.log('✓ Keystore initialized');
}

init();
"
```

### 2. Fund Your Agent Wallet

```bash
# Get your agent address
node -e "
const { KeystoreManager } = require('@noosphere/crypto');
const { ethers } = require('ethers');

async function getAddress() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const ks = new KeystoreManager('./.noosphere/keystore.json', process.env.KEYSTORE_PASSWORD);
  await ks.load();
  console.log('Agent address:', ks.getEOAAddress());
}

getAddress();
"
```

Send ETH to this address for gas fees.

## Running the Agent

### Development Mode

```bash
# Run the agent (background process)
npm run agent

# Run the Next.js dashboard (separate terminal)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the dashboard.

### Production Mode

```bash
# Build the Next.js app
npm run build

# Start both agent and web server
npm run agent &
npm start
```

## Agent Functionality

The agent performs the following operations:

1. **Load Keystore** - Securely loads wallet from encrypted keystore
2. **Connect to Blockchain** - WebSocket (preferred) or HTTP polling
3. **Load Registry** - Fetch container and verifier metadata
4. **Listen for Events** - Monitor `RequestStarted` events from Router contract
5. **Self-Coordination** - Determine priority based on position hash
6. **Execute Containers** - Run Docker containers with request data
7. **Submit Results** - Call Coordinator contract to deliver results
8. **Earn Fees** - Receive payment tokens for successful executions

## How It Works

### Event Flow

```
1. User creates subscription → Router emits RequestStarted
2. Agent listens for RequestStarted events
3. Agent calculates priority (self-coordination)
4. Agent waits based on priority (higher = less delay)
5. Agent checks if request is already fulfilled
6. Agent pulls container from registry
7. Agent executes container with request data
8. Agent submits result to Coordinator
9. Agent receives fee payment
```

### Self-Coordination

Agents coordinate without a central hub using **position-based priority**:

```typescript
priority = hash(requestId + agentAddress)
delay = (priority / MAX_UINT32) * MAX_DELAY

// Example:
// Agent A: priority = 0x0000FFFF → delay = 0ms (high priority)
// Agent B: priority = 0xFFFF0000 → delay = 200ms (low priority)
```

This ensures deterministic, fair ordering without communication between agents.

## Container Execution

Containers receive request data via stdin:

```json
{
  "requestId": "0x123...",
  "interval": 42
}
```

Containers output results to stdout:

```json
{
  "result": "computation result",
  "proof": "optional zk-proof"
}
```

## Monitoring

### Logs

The agent outputs structured logs:

```
🚀 Starting Noosphere Agent...
✓ Keystore loaded
✓ Registry loaded: 12 containers
✓ Connected to blockchain (WebSocket)
✓ Listening for events from block 5234567

[2024-12-26T12:00:00.000Z] RequestStarted: 0x123...
  SubscriptionId: 42
  ContainerId: 0xabc...
  Priority wait: 150ms
  ⚙️  Executing container...
  ✓ Execution completed in 2340ms
  📤 Submitting result...
  ✓ Result submitted
  💰 Fee earned: 0.001 ETH
```

### Dashboard

Access the web dashboard at `http://localhost:3000` to view:
- Agent status
- Recent requests processed
- Earnings summary
- Container registry

## Troubleshooting

### Agent won't start

**Error**: `Keystore not found`
- Solution: Run keystore initialization (see First-Time Setup)

**Error**: `Docker is not available`
- Solution: Ensure Docker daemon is running

**Error**: `Insufficient balance`
- Solution: Fund your agent wallet with ETH

### No requests received

- Check if subscriptions exist on the Router contract
- Verify Router address in .env
- Check deployment block is correct
- Ensure network connectivity

### Container execution fails

- Verify Docker is running
- Check container exists in registry
- Ensure container has correct image name
- Check Docker logs: `docker logs <container-id>`

## Development

### Adding Custom Containers

Add containers to your local registry:

```typescript
import { RegistryManager } from '@noosphere/registry';

const registry = new RegistryManager();
await registry.load();

await registry.addContainer({
  id: 'my-custom-container',
  name: 'My Model',
  imageName: 'myrepo/my-model:latest',
  port: 8000,
  statusCode: 'ACTIVE',
  tags: ['custom', 'ml'],
});
```

### Testing

```bash
# Install test dependencies
npm install --save-dev jest @types/jest

# Run tests
npm test
```

## Security

- **Never commit `.env` file** - Contains sensitive credentials
- **Backup keystore file** - Store securely offline
- **Use strong password** - For keystore encryption
- **Rotate keys regularly** - Update keystore password periodically
- **Monitor wallet balance** - Ensure sufficient funds for gas

## License

BSD-3-Clause-Clear

## Support

- Documentation: [https://github.com/hpp-io/noosphere-sdk](https://github.com/hpp-io/noosphere-sdk)
- Issues: [https://github.com/hpp-io/noosphere-agent-js/issues](https://github.com/hpp-io/noosphere-agent-js/issues)
