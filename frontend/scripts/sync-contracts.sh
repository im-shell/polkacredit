#!/usr/bin/env bash
#
# Refresh the contract ABIs + deployment JSONs baked into the frontend's
# static bundle (frontend/public/abi, frontend/public/deployments). Run this
# after a contract change so the production build (Vercel, Pages, Bulletin
# Chain, etc.) keeps shipping a matching ABI — those hosts don't run forge
# and can't produce artifacts at build time.
#
# Prereqs: foundry installed locally (`forge build` must succeed).
#
# Usage:   ./frontend/scripts/sync-contracts.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$FRONTEND/.." && pwd)"
CONTRACTS="$ROOT/contracts"

ABI_OUT="$FRONTEND/public/abi"
DEP_OUT="$FRONTEND/public/deployments"
NAMES=(PointsLedger StakingVault VouchRegistry ScoreRegistry MockStablecoin DisputeResolver)

echo "==> forge build (regenerate contracts/out/)"
( cd "$CONTRACTS" && forge build >/dev/null )

echo "==> syncing ABIs → $ABI_OUT"
mkdir -p "$ABI_OUT"
for name in "${NAMES[@]}"; do
  src="$CONTRACTS/out/${name}.sol/${name}.json"
  dst="$ABI_OUT/${name}.json"
  [ -f "$src" ] || { echo "  ✗ missing $src"; exit 1; }
  python3 -c "
import json
with open('$src') as f: d = json.load(f)
with open('$dst', 'w') as f: json.dump({'abi': d['abi']}, f)
"
  printf '  ✓ %-24s %6d bytes\n' "${name}.json" "$(wc -c < "$dst")"
done

echo "==> syncing deployments → $DEP_OUT"
mkdir -p "$DEP_OUT"
for f in "$CONTRACTS"/deployments/*.json; do
  cp "$f" "$DEP_OUT/$(basename "$f")"
  printf '  ✓ %s\n' "$(basename "$f")"
done

echo
echo "done. commit frontend/public/{abi,deployments}/ so Vercel / Pages ship them."
