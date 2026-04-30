#!/usr/bin/env bash
# =============================================================================
# Generate (or reuse) a relay EOA, fund it on anvil-eth, and whitelist it
# on the deployed thatsRekt proxy by impersonating the TimelockController.
#
# Idempotent:
#   - If $RELAY_EOA_KEY_FILE exists AND the corresponding address is already
#     whitelisted, this is a no-op.
#   - Otherwise: regenerate as needed and apply.
#
# Outputs:
#   /tmp/thatsrekt-relay-eoa.addr  — checksum address of the EOA
#   /tmp/thatsrekt-relay-eoa.key   — hex-encoded private key (no 0x prefix)
#
# Prereqs: cast, jq on PATH; anvil-eth running on $ANVIL_RPC; thatsRekt
# already deployed (.deployed.anvil-eth.json present).
# =============================================================================

set -euo pipefail

ANVIL_RPC="${ANVIL_RPC:-http://localhost:8545}"
RELAY_EOA_ADDR_FILE="${RELAY_EOA_ADDR_FILE:-/tmp/thatsrekt-relay-eoa.addr}"
RELAY_EOA_KEY_FILE="${RELAY_EOA_KEY_FILE:-/tmp/thatsrekt-relay-eoa.key}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOYED_JSON="$REPO_ROOT/contracts/script/anvil/.deployed.anvil-eth.json"

if [[ ! -f "$DEPLOYED_JSON" ]]; then
    echo "ERROR: $DEPLOYED_JSON not found — run \`make anvil-bootstrap\` first" >&2
    exit 1
fi

PROXY="$(jq -r .proxy "$DEPLOYED_JSON")"

# --- Reuse existing EOA if it's still whitelisted ----------------------------
if [[ -f "$RELAY_EOA_ADDR_FILE" && -f "$RELAY_EOA_KEY_FILE" ]]; then
    EXISTING_ADDR="$(cat "$RELAY_EOA_ADDR_FILE")"
    WL="$(cast call "$PROXY" "isWhitelisted(address)(bool)" "$EXISTING_ADDR" --rpc-url "$ANVIL_RPC" 2>/dev/null || echo "false")"
    if [[ "$WL" == "true" ]]; then
        echo "    relay EOA already whitelisted: $EXISTING_ADDR (no-op)"
        exit 0
    fi
    echo "    existing EOA $EXISTING_ADDR is no longer whitelisted — re-whitelisting"
    RELAY_EOA="$EXISTING_ADDR"
    RELAY_KEY="$(cat "$RELAY_EOA_KEY_FILE")"
else
    # --- Generate fresh EOA ---------------------------------------------------
    echo "    generating fresh relay EOA"
    WALLET_OUT="$(cast wallet new --json)"
    RELAY_EOA="$(echo "$WALLET_OUT" | jq -r '.[0].address')"
    RELAY_KEY="$(echo "$WALLET_OUT" | jq -r '.[0].private_key' | sed 's/^0x//')"
    echo "$RELAY_EOA" > "$RELAY_EOA_ADDR_FILE"
    echo "$RELAY_KEY" > "$RELAY_EOA_KEY_FILE"
    chmod 600 "$RELAY_EOA_KEY_FILE"
fi

# --- Fund the new relay EOA -------------------------------------------------
cast rpc anvil_setBalance "$RELAY_EOA" "0x56BC75E2D63100000" --rpc-url "$ANVIL_RPC" >/dev/null  # 100 ETH

# --- addWhitelisted via the dev EOA (whitelist admin) ----------------------
# After the two-tier governance refactor, addWhitelisted is gated by the
# whitelistAdmin role rather than onlyOwner. In dev the dev EOA holds that
# role (set in DeployDev.s.sol), so we can call directly with its key —
# no timelock impersonation needed.
DEV_KEY="${DEV_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
cast send "$PROXY" "addWhitelisted(address)" "$RELAY_EOA" \
    --rpc-url "$ANVIL_RPC" --private-key "$DEV_KEY" >/dev/null

# --- Verify ------------------------------------------------------------------
WL="$(cast call "$PROXY" "isWhitelisted(address)(bool)" "$RELAY_EOA" --rpc-url "$ANVIL_RPC")"
if [[ "$WL" != "true" ]]; then
    echo "ERROR: relay EOA was not whitelisted (got: $WL)" >&2
    exit 1
fi
echo "    relay EOA whitelisted: $RELAY_EOA"
