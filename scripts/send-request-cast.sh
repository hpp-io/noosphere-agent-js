#!/bin/bash
#
# Send Test Request using Cast
#
# This is a simpler alternative to the TypeScript script
# Requires: foundry (cast command)
#
# Usage:
#   ./scripts/send-request-cast.sh
#

set -e

# Load environment variables
source .env

# Configuration
RPC_URL="https://sepolia.hpp.io"
CHAIN_ID=181228
CLIENT_ADDRESS="${CLIENT_ADDRESS:-0xab544ec8767738c07d989c67a8eea6d467646808}"
WALLET_FACTORY_ADDRESS="${WALLET_FACTORY_ADDRESS:-0xfe1e1d41840e2f1e445012fce6bb7ed4177c9e3e}"

echo "🚀 Sending Test Request using Cast"
echo ""
echo "📋 Configuration:"
echo "  RPC URL: $RPC_URL"
echo "  Client: $CLIENT_ADDRESS"
echo "  WalletFactory: $WALLET_FACTORY_ADDRESS"
echo ""

# Get sender address
SENDER=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "👤 Sender: $SENDER"

# Check balance
BALANCE=$(cast balance "$SENDER" --rpc-url "$RPC_URL")
echo "💰 Balance: $(cast to-unit "$BALANCE" ether) ETH"
echo ""

# Check if payment wallet exists
echo "💳 Checking payment wallet..."
PAYMENT_WALLET=$(cast call "$WALLET_FACTORY_ADDRESS" \
  "getWallet(address)(address)" \
  "$SENDER" \
  --rpc-url "$RPC_URL")

if [ "$PAYMENT_WALLET" = "0x0000000000000000000000000000000000000000" ]; then
  echo "  Creating payment wallet..."
  TX_HASH=$(cast send "$WALLET_FACTORY_ADDRESS" \
    "createWallet(address)" \
    "$SENDER" \
    --private-key "$PRIVATE_KEY" \
    --rpc-url "$RPC_URL" \
    --chain-id "$CHAIN_ID" \
    --json | jq -r '.transactionHash')

  echo "  ✓ Wallet creation tx: $TX_HASH"

  # Wait for confirmation
  cast receipt "$TX_HASH" --rpc-url "$RPC_URL" > /dev/null

  # Get the created wallet address
  PAYMENT_WALLET=$(cast call "$WALLET_FACTORY_ADDRESS" \
    "getWallet(address)(address)" \
    "$SENDER" \
    --rpc-url "$RPC_URL")

  echo "  ✓ Payment wallet: $PAYMENT_WALLET"

  # Fund the wallet
  echo "  Funding payment wallet with 0.1 ETH..."
  FUND_TX=$(cast send "$PAYMENT_WALLET" \
    --value 0.1ether \
    --private-key "$PRIVATE_KEY" \
    --rpc-url "$RPC_URL" \
    --chain-id "$CHAIN_ID" \
    --json | jq -r '.transactionHash')

  echo "  ✓ Funding tx: $FUND_TX"
  cast receipt "$FUND_TX" --rpc-url "$RPC_URL" > /dev/null
else
  echo "  ✓ Payment wallet exists: $PAYMENT_WALLET"
fi

WALLET_BALANCE=$(cast balance "$PAYMENT_WALLET" --rpc-url "$RPC_URL")
echo "  Balance: $(cast to-unit "$WALLET_BALANCE" ether) ETH"
echo ""

# Subscription parameters
CONTAINER_ID="noosphere-hello-world"
REDUNDANCY=1
USE_INBOX=false
PAYMENT_TOKEN="0x0000000000000000000000000000000000000000"  # Native ETH
FEE_AMOUNT=0
VERIFIER="0x0000000000000000000000000000000000000000"
ROUTE_ID=$(cast format-bytes32-string "Coordinator_v1.0.0")

echo "📦 Creating Subscription:"
echo "  Container: $CONTAINER_ID"
echo "  Redundancy: $REDUNDANCY"
echo ""

# Create subscription
echo "⏳ Creating subscription..."
CREATE_TX=$(cast send "$CLIENT_ADDRESS" \
  "createSubscription(string,uint16,bool,address,uint256,address,address,bytes32)" \
  "$CONTAINER_ID" \
  "$REDUNDANCY" \
  "$USE_INBOX" \
  "$PAYMENT_TOKEN" \
  "$FEE_AMOUNT" \
  "$PAYMENT_WALLET" \
  "$VERIFIER" \
  "$ROUTE_ID" \
  --private-key "$PRIVATE_KEY" \
  --rpc-url "$RPC_URL" \
  --chain-id "$CHAIN_ID" \
  --gas-limit 500000 \
  --json | jq -r '.transactionHash')

echo "  ✓ Transaction: $CREATE_TX"

# Wait for receipt
RECEIPT=$(cast receipt "$CREATE_TX" --rpc-url "$RPC_URL" --json)

# Extract subscription ID from logs (last topic of last log)
SUBSCRIPTION_ID=$(echo "$RECEIPT" | jq -r '.logs[-1].topics[1]')
SUBSCRIPTION_ID_DEC=$(cast to-dec "$SUBSCRIPTION_ID")

echo "  ✓ Subscription ID: $SUBSCRIPTION_ID_DEC"
echo ""

# Trigger request
echo "🎯 Triggering Compute Request..."
REQUEST_TX=$(cast send "$CLIENT_ADDRESS" \
  "requestCompute(uint64,bytes)" \
  "$SUBSCRIPTION_ID_DEC" \
  "0x" \
  --private-key "$PRIVATE_KEY" \
  --rpc-url "$RPC_URL" \
  --chain-id "$CHAIN_ID" \
  --gas-limit 300000 \
  --json | jq -r '.transactionHash')

echo "  ✓ Transaction: $REQUEST_TX"
echo ""

echo "✅ Test Request Sent Successfully!"
echo ""
echo "📊 Next Steps:"
echo "  1. Check agent logs for RequestStarted event"
echo "  2. Watch for container execution"
echo "  3. Wait for result transaction"
echo "  4. View on explorer:"
echo "     https://explorer.hpp.io/tx/$REQUEST_TX"
echo ""
