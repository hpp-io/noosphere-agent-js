#!/bin/bash

# E2E Test Script for Agent-JS on Anvil
# This script automates the full end-to-end testing process

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Paths
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
AGENT_ROOT="$(dirname "$SCRIPT_DIR")"
SDK_ROOT="$AGENT_ROOT/../noosphere-sdk"
EVM_ROOT="$AGENT_ROOT/../noosphere-evm"

# Configuration
ANVIL_PORT=8545
ANVIL_RPC="http://127.0.0.1:$ANVIL_PORT"
ANVIL_PID_FILE="/tmp/anvil-e2e.pid"
AGENT_PID_FILE="/tmp/agent-e2e.pid"

# Anvil default accounts
DEPLOYER_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOYER_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

AGENT_PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
AGENT_ADDRESS="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

# Deployed contract addresses (will be populated after deployment)
ROUTER_ADDRESS=""
COORDINATOR_ADDRESS=""
WALLET_FACTORY_ADDRESS=""
READER_ADDRESS=""

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Noosphere Agent-JS E2E Test Suite   ║${NC}"
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo ""

#------------------------------------------------------------------------------
# Utility Functions
#------------------------------------------------------------------------------

function log_info() {
    echo -e "${GREEN}✓${NC} $1"
}

function log_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

function log_error() {
    echo -e "${RED}✗${NC} $1"
}

function log_step() {
    echo -e "\n${BLUE}▶${NC} $1\n"
}

function cleanup() {
    log_step "Cleaning up..."

    # Kill Anvil
    if [ -f "$ANVIL_PID_FILE" ]; then
        ANVIL_PID=$(cat "$ANVIL_PID_FILE")
        if kill -0 "$ANVIL_PID" 2>/dev/null; then
            log_info "Stopping Anvil (PID: $ANVIL_PID)"
            kill "$ANVIL_PID"
        fi
        rm -f "$ANVIL_PID_FILE"
    fi

    # Kill Agent
    if [ -f "$AGENT_PID_FILE" ]; then
        AGENT_PID=$(cat "$AGENT_PID_FILE")
        if kill -0 "$AGENT_PID" 2>/dev/null; then
            log_info "Stopping Agent (PID: $AGENT_PID)"
            kill "$AGENT_PID"
        fi
        rm -f "$AGENT_PID_FILE"
    fi

    # Restore original config.json if backup exists
    if [ -f "config.json.backup-e2e" ]; then
        mv config.json.backup-e2e config.json
        log_info "Restored original config.json"
    elif [ -L "config.json" ]; then
        # Remove symlink if it exists
        rm -f config.json
        log_info "Removed e2e config symlink"
    fi

    # Remove e2e keystore
    rm -f .noosphere/keystore-e2e.json

    log_info "Cleanup complete"
}

trap cleanup EXIT

#------------------------------------------------------------------------------
# Step 1: Prerequisites Check
#------------------------------------------------------------------------------

log_step "Step 1: Checking Prerequisites"

# Check Foundry
if ! command -v forge &> /dev/null; then
    log_error "Foundry not found. Please install: https://book.getfoundry.sh/getting-started/installation"
    exit 1
fi
log_info "Foundry installed: $(forge --version | head -n1)"

if ! command -v anvil &> /dev/null; then
    log_error "Anvil not found. Please install Foundry."
    exit 1
fi
log_info "Anvil installed: $(anvil --version | head -n1)"

# Check Docker
if ! command -v docker &> /dev/null; then
    log_error "Docker not found. Please install Docker."
    exit 1
fi
log_info "Docker installed: $(docker --version)"

# Check if Docker is running
if ! docker ps &> /dev/null; then
    log_error "Docker daemon is not running. Please start Docker."
    exit 1
fi
log_info "Docker daemon is running"

# Check Node.js
if ! command -v node &> /dev/null; then
    log_error "Node.js not found. Please install Node.js."
    exit 1
fi
log_info "Node.js installed: $(node --version)"

# Check if repos exist
if [ ! -d "$EVM_ROOT" ]; then
    log_error "noosphere-evm not found at: $EVM_ROOT"
    exit 1
fi
log_info "noosphere-evm found"

if [ ! -d "$SDK_ROOT" ]; then
    log_error "noosphere-sdk not found at: $SDK_ROOT"
    exit 1
fi
log_info "noosphere-sdk found"

#------------------------------------------------------------------------------
# Step 2: Build SDK
#------------------------------------------------------------------------------

log_step "Step 2: Building SDK Packages"

cd "$SDK_ROOT/packages/contracts"
log_info "Building @noosphere/contracts..."
npm run build > /dev/null 2>&1

cd "$SDK_ROOT/packages/agent-core"
log_info "Building @noosphere/agent-core..."
npm run build > /dev/null 2>&1

log_info "SDK packages built successfully"

#------------------------------------------------------------------------------
# Step 3: Start Anvil
#------------------------------------------------------------------------------

log_step "Step 3: Starting Anvil"

# Kill existing Anvil if running
if lsof -Pi :$ANVIL_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    log_warn "Port $ANVIL_PORT is in use. Killing existing process..."
    lsof -ti:$ANVIL_PORT | xargs kill -9 2>/dev/null || true
    sleep 2
fi

# Start Anvil in background
anvil --block-time 2 --gas-limit 30000000 --port $ANVIL_PORT > /tmp/anvil-e2e.log 2>&1 &
ANVIL_PID=$!
echo $ANVIL_PID > "$ANVIL_PID_FILE"

# Wait for Anvil to start
log_info "Waiting for Anvil to start (PID: $ANVIL_PID)..."
sleep 3

# Verify Anvil is running
if ! kill -0 "$ANVIL_PID" 2>/dev/null; then
    log_error "Anvil failed to start. Check /tmp/anvil-e2e.log"
    exit 1
fi

# Test RPC connection
if ! curl -s -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$ANVIL_RPC" > /dev/null; then
    log_error "Cannot connect to Anvil RPC"
    exit 1
fi

log_info "Anvil started successfully at $ANVIL_RPC"

#------------------------------------------------------------------------------
# Step 4: Deploy Contracts
#------------------------------------------------------------------------------

log_step "Step 4: Deploying Contracts"

cd "$EVM_ROOT"

export PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY"
export PRODUCTION_OWNER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY"

log_info "Deploying contracts with DeployTest..."
set +e  # Temporarily disable exit on error for forge script
DEPLOY_OUTPUT=$(forge script scripts/DeployTest.sol:DeployTest \
    --rpc-url "$ANVIL_RPC" \
    --broadcast \
    --legacy \
    --sig "run(address,address)" "$DEPLOYER_ADDRESS" "$DEPLOYER_ADDRESS" 2>&1)
FORGE_EXIT_CODE=$?
set -e  # Re-enable exit on error

# Check if deployment actually succeeded by looking for success message
if ! echo "$DEPLOY_OUTPUT" | grep -q "Script ran successfully"; then
    log_error "Contract deployment failed"
    echo "$DEPLOY_OUTPUT"
    exit 1
fi

# Extract contract addresses from output
ROUTER_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "Router:" | awk '{print $2}')
COORDINATOR_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "Coordinator:" | awk '{print $2}')
WALLET_FACTORY_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "WalletFactory:" | awk '{print $2}')
READER_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "Reader:" | awk '{print $2}')
CLIENT_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "MyTransientClient:" | awk '{print $2}')

if [ -z "$ROUTER_ADDRESS" ] || [ -z "$COORDINATOR_ADDRESS" ] || [ -z "$CLIENT_ADDRESS" ]; then
    log_error "Failed to extract contract addresses from deployment"
    echo "$DEPLOY_OUTPUT"
    exit 1
fi

echo ""
log_info "Contract Deployment Summary:"
echo "  Router:          $ROUTER_ADDRESS"
echo "  Coordinator:     $COORDINATOR_ADDRESS"
echo "  Client:          $CLIENT_ADDRESS"
echo "  WalletFactory:   $WALLET_FACTORY_ADDRESS"
echo "  Reader:          $READER_ADDRESS"

#------------------------------------------------------------------------------
# Step 5: Configure Agent
#------------------------------------------------------------------------------

log_step "Step 5: Configuring Agent"

cd "$AGENT_ROOT"

# Create .noosphere directory
mkdir -p .noosphere

# Create encrypted keystore using Node.js (separate e2e keystore)
log_info "Creating encrypted e2e keystore (this may take a moment)..."
node -e "
const { KeystoreManager } = require('$SDK_ROOT/packages/crypto/dist/KeystoreManager.js');
const { ethers } = require('ethers');

async function createKeystore() {
  const provider = new ethers.JsonRpcProvider('$ANVIL_RPC');
  const keystorePath = './.noosphere/keystore-e2e.json';
  const password = 'test123';
  const privateKey = '$AGENT_PRIVATE_KEY';

  await KeystoreManager.initialize(keystorePath, password, privateKey, provider);
}

createKeystore().catch(console.error);
" 2>&1 | grep -v "Encrypting\|✓ Keystore"
log_info "Created e2e keystore for agent: $AGENT_ADDRESS"

# Fund agent wallet
log_info "Funding agent wallet with 10 ETH..."
cast send --private-key "$DEPLOYER_PRIVATE_KEY" \
    --rpc-url "$ANVIL_RPC" \
    --value 10ether \
    "$AGENT_ADDRESS" > /dev/null 2>&1

AGENT_BALANCE=$(cast balance --rpc-url "$ANVIL_RPC" "$AGENT_ADDRESS")
log_info "Agent balance: $(cast --to-unit "$AGENT_BALANCE" ether) ETH"

# Create WalletFactory wallet for the agent
log_info "Creating WalletFactory wallet for agent..."
# Call createWallet and capture the output
cast send "$WALLET_FACTORY_ADDRESS" \
    --private-key "$AGENT_PRIVATE_KEY" \
    --rpc-url "$ANVIL_RPC" \
    "createWallet(address)" "$AGENT_ADDRESS" > /tmp/wallet-create.log 2>&1

# Extract the wallet address from the WalletCreated event data field
# The event signature is: WalletCreated(address indexed operator, address indexed owner, address walletAddress)
# walletAddress is NOT indexed, so it's in the data field (last log entry)
AGENT_WALLET=$(grep -o '"data":"0x[0-9a-f]*"' /tmp/wallet-create.log | \
    tail -1 | \
    cut -d'"' -f4 | \
    sed 's/^0x000000000000000000000000/0x/')

if [ -z "$AGENT_WALLET" ] || [ "$AGENT_WALLET" = "0x" ]; then
    log_error "Failed to extract agent wallet address"
    cat /tmp/wallet-create.log
    exit 1
fi

log_info "Created agent wallet: $AGENT_WALLET"

# Backup existing config.json if it exists
if [ -f "config.json" ]; then
  cp config.json config.json.backup-e2e
  log_info "Backed up existing config.json"
fi

# Create e2e-specific config
cat > config-e2e.json <<EOF
{
  "chain": {
    "enabled": true,
    "rpcUrl": "$ANVIL_RPC",
    "wsRpcUrl": "ws://127.0.0.1:$ANVIL_PORT",
    "routerAddress": "$ROUTER_ADDRESS",
    "coordinatorAddress": "$COORDINATOR_ADDRESS",
    "deploymentBlock": 0,
    "processingInterval": 2000,
    "wallet": {
      "keystorePath": "./.noosphere/keystore-e2e.json",
      "paymentAddress": "$AGENT_WALLET"
    }
  },
  "containers": [
    {
      "id": "noosphere-hello-world",
      "image": "ghcr.io/hpp-io/example-hello-world-noosphere:latest",
      "port": "8081"
    }
  ],
  "scheduler": {
    "enabled": true,
    "cronIntervalMs": 60000,
    "syncPeriodMs": 3000
  }
}
EOF

# Symlink config-e2e.json to config.json for agent to use
ln -sf config-e2e.json config.json
log_info "Created config-e2e.json with deployed contract addresses and agent wallet"

#------------------------------------------------------------------------------
# Step 6: Pull Container Image
#------------------------------------------------------------------------------

log_step "Step 6: Preparing Container Image"

if docker pull ghcr.io/hpp-io/example-hello-world-noosphere:latest > /dev/null 2>&1; then
    log_info "Container image pulled successfully"
else
    log_warn "Failed to pull container image (may already exist locally)"
fi

#------------------------------------------------------------------------------
# Step 7: Start Agent
#------------------------------------------------------------------------------

log_step "Step 7: Starting Agent"

cd "$AGENT_ROOT"

# Start agent in background
KEYSTORE_PASSWORD=test123 npm run agent > /tmp/agent-e2e.log 2>&1 &
AGENT_PID=$!
echo $AGENT_PID > "$AGENT_PID_FILE"

log_info "Waiting for agent to start (PID: $AGENT_PID)..."
sleep 8

# Check if agent is still running
if ! kill -0 "$AGENT_PID" 2>/dev/null; then
    log_error "Agent failed to start. Check /tmp/agent-e2e.log"
    tail -20 /tmp/agent-e2e.log
    exit 1
fi

# Check agent logs for success indicators
if grep -q "Agent is running" /tmp/agent-e2e.log; then
    log_info "Agent started successfully"
else
    log_warn "Agent may not have started correctly. Check logs."
fi

#------------------------------------------------------------------------------
# Step 8: Trigger Request
#------------------------------------------------------------------------------

log_step "Step 8: Creating Subscription and Triggering Request"

cd "$EVM_ROOT"

export CLIENT_ADDRESS="$CLIENT_ADDRESS"
export WALLET_FACTORY_ADDRESS="$WALLET_FACTORY_ADDRESS"

log_info "Executing TriggerRequest script..."
set +e  # Don't exit on error temporarily
TRIGGER_OUTPUT=$(forge script scripts/TriggerRequest.sol:TriggerRequest \
    --rpc-url "$ANVIL_RPC" \
    --broadcast \
    --legacy 2>&1)
FORGE_EXIT_CODE=$?
set -e

log_info "Forge exit code: $FORGE_EXIT_CODE"

# Show relevant output
echo "=== TriggerRequest Output ==="
echo "$TRIGGER_OUTPUT" | grep -E "(Subscription|Request|Container|Route|===|✓|Error|failed)" || echo "(no matching output)"
echo "==========================="

if echo "$TRIGGER_OUTPUT" | grep -q "triggered successfully"; then
    log_info "Request triggered successfully"
elif echo "$TRIGGER_OUTPUT" | grep -q "Script ran successfully"; then
    log_info "Script completed (checking for success)"
else
    log_error "Failed to trigger request. Full output:"
    echo "---"
    echo "$TRIGGER_OUTPUT"
    echo "---"
    exit 1
fi

#------------------------------------------------------------------------------
# Step 9: Monitor Agent Execution
#------------------------------------------------------------------------------

log_step "Step 9: Monitoring Agent Execution"

log_info "Waiting for agent to process request (30 seconds)..."
echo ""

# Monitor agent logs
for i in {1..30}; do
    sleep 1

    # Check for RequestStarted event
    if grep -q "RequestStarted" /tmp/agent-e2e.log && ! grep -q "EVENT_DETECTED" /tmp/.e2e-markers 2>/dev/null; then
        echo "EVENT_DETECTED" > /tmp/.e2e-markers
        log_info "✓ RequestStarted event detected"
    fi

    # Check for container execution
    if grep -q "Executing..." /tmp/agent-e2e.log && ! grep -q "CONTAINER_EXECUTING" /tmp/.e2e-markers 2>/dev/null; then
        echo "CONTAINER_EXECUTING" >> /tmp/.e2e-markers
        log_info "✓ Container execution started"
    fi

    # Check for execution completion
    if grep -q "Execution completed" /tmp/agent-e2e.log && ! grep -q "CONTAINER_COMPLETED" /tmp/.e2e-markers 2>/dev/null; then
        echo "CONTAINER_COMPLETED" >> /tmp/.e2e-markers
        log_info "✓ Container execution completed"
    fi

    # Check for transaction submission
    if grep -q "Transaction sent" /tmp/agent-e2e.log && ! grep -q "TX_SUBMITTED" /tmp/.e2e-markers 2>/dev/null; then
        echo "TX_SUBMITTED" >> /tmp/.e2e-markers
        log_info "✓ Transaction submitted"
    fi

    # Check for delivery success
    if grep -q "Result delivered successfully" /tmp/agent-e2e.log && ! grep -q "DELIVERY_SUCCESS" /tmp/.e2e-markers 2>/dev/null; then
        echo "DELIVERY_SUCCESS" >> /tmp/.e2e-markers
        log_info "✓ Result delivered successfully"
        break
    fi

    echo -n "."
done
echo ""

rm -f /tmp/.e2e-markers

#------------------------------------------------------------------------------
# Step 10: Verify Results
#------------------------------------------------------------------------------

log_step "Step 10: Verification Results"

# Count successful steps
STEPS_COMPLETED=0

if grep -q "RequestStarted" /tmp/agent-e2e.log; then
    log_info "✓ Event Detection: PASS"
    ((STEPS_COMPLETED++))
else
    log_error "✗ Event Detection: FAIL"
fi

if grep -q "Executing..." /tmp/agent-e2e.log; then
    log_info "✓ Container Execution: PASS"
    ((STEPS_COMPLETED++))
else
    log_error "✗ Container Execution: FAIL"
fi

if grep -q "Transaction sent" /tmp/agent-e2e.log; then
    log_info "✓ Transaction Submission: PASS"
    ((STEPS_COMPLETED++))
else
    log_error "✗ Transaction Submission: FAIL"
fi

if grep -q "Result delivered successfully" /tmp/agent-e2e.log; then
    log_info "✓ Result Delivery: PASS"
    ((STEPS_COMPLETED++))
else
    log_error "✗ Result Delivery: FAIL"
fi

# Final summary
echo ""
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo -e "${BLUE}           Test Summary                ${NC}"
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo ""
echo "  Steps Completed: $STEPS_COMPLETED / 4"
echo ""

if [ "$STEPS_COMPLETED" -eq 4 ]; then
    echo -e "${GREEN}✓ ALL TESTS PASSED!${NC}"
    echo ""
    echo "The agent successfully:"
    echo "  1. Received the RequestStarted event"
    echo "  2. Executed the container"
    echo "  3. Submitted the result transaction"
    echo "  4. Delivered the result on-chain"
    EXIT_CODE=0
else
    echo -e "${RED}✗ SOME TESTS FAILED${NC}"
    echo ""
    echo "Check logs for details:"
    echo "  Agent:  /tmp/agent-e2e.log"
    echo "  Anvil:  /tmp/anvil-e2e.log"
    EXIT_CODE=1
fi

echo ""
echo "Log files:"
echo "  Agent:  /tmp/agent-e2e.log"
echo "  Anvil:  /tmp/anvil-e2e.log"
echo ""

# Cleanup will be called by trap
exit $EXIT_CODE
