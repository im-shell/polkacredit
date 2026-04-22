#!/usr/bin/env bash
# Deploys the PolkaCredit contract suite to a locally-running zombienet
# (started via `scripts/start-zombienet.sh`). Uses the template's Alice
# dev key so pre-funded balance is available on the eth-rpc adapter.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"

ETH_RPC_HTTP="${ETH_RPC_HTTP:-http://127.0.0.1:8545}"
# Alice dev account private key (matches the polkadot-stack-template default).
: "${DEPLOYER_PRIVATE_KEY:=0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133}"

echo "=== PolkaCredit local deploy ==="
echo "RPC: $ETH_RPC_HTTP"

if ! curl -sf -o /dev/null -X POST -H 'Content-Type: application/json' \
        --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
        "$ETH_RPC_HTTP"; then
    echo "ERROR: eth-rpc not reachable at $ETH_RPC_HTTP" >&2
    echo "       Run ./scripts/start-zombienet.sh first." >&2
    exit 1
fi

cd "$CONTRACTS_DIR"

echo "Building contracts..."
forge build

echo "Deploying..."
DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
forge script script/Deploy.s.sol \
    --rpc-url "$ETH_RPC_HTTP" \
    --private-key "$DEPLOYER_PRIVATE_KEY" \
    --broadcast \
    --skip-simulation \
    -vvv

echo ""
echo "=== Deploy complete ==="
echo "Broadcast artifacts in: $CONTRACTS_DIR/broadcast/"
