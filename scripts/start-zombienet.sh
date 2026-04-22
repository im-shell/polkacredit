#!/usr/bin/env bash
# Starts the polkadot-stack-template's zombienet (relay + parachain + eth-rpc)
# in the background and blocks until both RPCs are reachable. Intended to be
# followed by `scripts/deploy-local.sh` to push PolkaCredit contracts onto the
# running chain.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_DIR="${TEMPLATE_DIR:-$(cd "$ROOT_DIR/../../polkadot-stack-template" && pwd)}"

if [[ ! -d "$TEMPLATE_DIR" ]]; then
    echo "ERROR: polkadot-stack-template not found at $TEMPLATE_DIR" >&2
    echo "       Set TEMPLATE_DIR to override." >&2
    exit 1
fi

# shellcheck disable=SC1091
source "$TEMPLATE_DIR/scripts/common.sh"

# The template's build/chain-spec helpers run relative to CWD (for cargo and
# chain-spec-builder). Run from the template root so its Cargo workspace and
# runtime wasm paths resolve.
cd "$TEMPLATE_DIR"

trap 'cleanup_zombienet; if [[ -n "${ETH_RPC_PID:-}" ]]; then kill "$ETH_RPC_PID" 2>/dev/null || true; fi' EXIT INT TERM

echo "=== PolkaCredit — local zombienet via polkadot-stack-template ==="

echo "[1/5] Validating toolchain..."
validate_full_external_toolchain
validate_full_stack_ports

echo "[2/5] Building runtime (skipped if already compiled)..."
build_runtime

echo "[3/5] Generating chain spec..."
generate_chain_spec

echo "[4/5] Starting zombienet..."
start_zombienet_background
wait_for_substrate_rpc

echo "[5/5] Starting eth-rpc adapter..."
start_eth_rpc_background
wait_for_eth_rpc

echo ""
echo "=== Ready ==="
log_info "Substrate RPC: $SUBSTRATE_RPC_WS"
log_info "Ethereum RPC:  $ETH_RPC_HTTP"
log_info "Zombienet dir: $ZOMBIE_DIR"
echo ""
log_info "Deploy PolkaCredit next via: ./scripts/deploy-local.sh"
log_info "Ctrl+C here to tear everything down."

wait "$ZOMBIE_PID"
