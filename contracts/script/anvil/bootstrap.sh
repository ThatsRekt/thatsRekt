#!/usr/bin/env bash
# =============================================================================
# Anvil bootstrap — deploys thatsRekt onto a running Anvil and emits the
# resulting addresses + start block to .deployed.<chain>.json.
# =============================================================================
# Usage:
#   bootstrap.sh anvil-eth      # deploys onto the Ethereum mainnet fork
#   bootstrap.sh anvil-base     # deploys onto the Base mainnet fork
#
# Default if no arg: anvil-eth.
#
# Prerequisite: the matching Anvil docker service must already be running.
#   cd indexer
#   docker compose -f docker-compose.yml -f docker-compose.anvil.yml up -d \
#       anvil-eth anvil-base
#
# The bootstrap is idempotent — DeployDev.s.sol detects already-deployed
# CREATE2 contracts and short-circuits, so re-running is a no-op.
#
# Output: contracts/script/anvil/.deployed.<chain>.json (gitignored). The
# file's `proxy` and `blockNumber` fields are what go into indexer/.env as
# CONTRACT_<CHAIN>_UPPER + START_BLOCK_<CHAIN>_UPPER.
# =============================================================================

set -euo pipefail

# --- Args + per-chain config -------------------------------------------------
CHAIN="${1:-anvil-eth}"

case "$CHAIN" in
  anvil-eth)
    DEFAULT_RPC="http://localhost:8545"
    EXPECTED_CHAIN_ID=31337
    UPPER="ETH"
    ;;
  anvil-base)
    DEFAULT_RPC="http://localhost:8546"
    EXPECTED_CHAIN_ID=31338
    UPPER="BASE"
    ;;
  *)
    echo "ERROR: unknown chain \"$CHAIN\". Expected: anvil-eth | anvil-base" >&2
    exit 64
    ;;
esac

# Override-able via env
ANVIL_RPC="${ANVIL_RPC:-$DEFAULT_RPC}"
DEV_EOA="${DEV_EOA:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"
# Anvil default account 0 private key. Public on the foundry website; safe to
# hardcode because it's the canonical dev key. NEVER use this on mainnet.
DEV_KEY="${DEV_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_JSON="$SCRIPT_DIR/.deployed.$CHAIN.json"
TMP_LOG="$(mktemp -t thatsrekt-bootstrap.XXXXXX)"
trap 'rm -f "$TMP_LOG"' EXIT

# --- 1. Verify Anvil is reachable -------------------------------------------
echo "==> Bootstrapping $CHAIN at $ANVIL_RPC"
if ! CHAIN_ID=$(cast chain-id --rpc-url "$ANVIL_RPC" 2>/dev/null); then
    cat <<EOF >&2
ERROR: Anvil not reachable at $ANVIL_RPC.

Start the corresponding Anvil service first:

  cd indexer
  docker compose -f docker-compose.yml -f docker-compose.anvil.yml up -d $CHAIN

EOF
    exit 1
fi
if [[ "$CHAIN_ID" != "$EXPECTED_CHAIN_ID" ]]; then
    echo "ERROR: expected chainId $EXPECTED_CHAIN_ID for $CHAIN, got $CHAIN_ID" >&2
    exit 2
fi
echo "    chain-id = $CHAIN_ID (✓)"

# --- 2. Deploy via DeployDev.s.sol ------------------------------------------
echo "==> Deploying thatsRekt via DeployDev.s.sol (owner=$DEV_EOA)"
cd "$CONTRACTS_DIR"

GOVERNANCE_OWNER="$DEV_EOA" \
forge script script/DeployDev.s.sol \
    --rpc-url "$ANVIL_RPC" \
    --private-key "$DEV_KEY" \
    --broadcast \
    --slow \
    -vvv 2>&1 | tee "$TMP_LOG"

# --- 3. Extract addresses + current block -----------------------------------
PROXY=$(grep -E '^\s*Proxy:' "$TMP_LOG" | tail -1 | awk '{print $NF}')
TIMELOCK=$(grep -E '^\s*TimelockController:' "$TMP_LOG" | tail -1 | awk '{print $NF}')
IMPL=$(grep -E '^\s*Implementation:' "$TMP_LOG" | tail -1 | awk '{print $NF}')
BLOCK=$(cast block-number --rpc-url "$ANVIL_RPC")

if [[ -z "$PROXY" || -z "$TIMELOCK" || -z "$IMPL" ]]; then
    echo "ERROR: failed to extract deployed addresses from forge script output." >&2
    exit 3
fi

# --- 4. Write .deployed.<chain>.json ----------------------------------------
cat > "$OUT_JSON" <<EOF
{
  "chain": "$CHAIN",
  "chainId": $CHAIN_ID,
  "blockNumber": $BLOCK,
  "implementation": "$IMPL",
  "timelock": "$TIMELOCK",
  "proxy": "$PROXY",
  "owner": "$DEV_EOA"
}
EOF

echo
echo "==> Wrote $OUT_JSON"
cat "$OUT_JSON"
echo
echo "==> Paste into indexer/.env:"
echo "    CONTRACT_ANVIL_${UPPER}=$PROXY"
echo "    START_BLOCK_ANVIL_${UPPER}=$BLOCK"
