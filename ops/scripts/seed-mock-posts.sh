#!/usr/bin/env bash
# =============================================================================
# Seed a small set of mock on-chain posts on the local anvils so the feed
# isn't empty during UI smoke tests.
#
# What this exercises:
#
#   1. Whitelist the dev EOA (anvil account 0) on BOTH anvil-eth and
#      anvil-base by impersonating the deployed TimelockController. This
#      side-steps the 7-day timelock — same trick `whitelist-relay-eoa.sh`
#      uses for the relay's runtime EOA.
#   2. Send a handful of `post()` calls per chain with realistic-looking
#      titles + attacker / victim addresses + a short note.
#   3. Print a summary so you can `cast call <proxy> postCount()(uint256)`
#      to sanity-check.
#
# Idempotent: re-running just appends more posts (whitelist no-ops if
# already set). Use `make dev-reset` to wipe state and start fresh.
#
# Prereqs:
#   make lan-up              # docker stack: db, anvils, indexer, mesh, frontend
#   make anvil-bootstrap     # deploys thatsRekt to both anvils
#
# Usage:
#   ./ops/scripts/seed-mock-posts.sh             # 5 posts per chain
#   POSTS_PER_CHAIN=10 ./ops/scripts/seed-mock-posts.sh
#
# Exit codes: 0 = success, non-zero = something failed (an offending step
# is printed to stderr).
# =============================================================================

set -euo pipefail

POSTS_PER_CHAIN="${POSTS_PER_CHAIN:-5}"

# Anvil default account 0 — `make anvil-bootstrap` already uses this same
# key; reusing it means we don't need to fund a fresh one.
DEV_EOA="${DEV_EOA:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"
DEV_KEY="${DEV_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOYED_DIR="$REPO_ROOT/contracts/script/anvil"

# --- Prereq checks ----------------------------------------------------------
for tool in cast jq; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: $tool not found on PATH" >&2
        exit 1
    fi
done

# Per-chain registry: slug | rpc | deployed.json
CHAINS=(
    "anvil-eth|http://localhost:8545|$DEPLOYED_DIR/.deployed.anvil-eth.json"
    "anvil-base|http://localhost:8546|$DEPLOYED_DIR/.deployed.anvil-base.json"
)

# --- Mock incident catalogue ------------------------------------------------
# Title                                      | attackers (csv)            | victims (csv)              | note
# Lowercased addresses on purpose — match the indexer's `Address.id`
# normalization, so AddressLabel + cross-chain dedup work the same as
# real on-chain posts.
MOCK_POSTS=(
    "Mock Lend — flashloan price-oracle exploit drains \$12M USDC|0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef|0x1234567890123456789012345678901234567890|Attacker manipulated the spot oracle in a single tx via a wstETH/USDC flashloan. Funds routed through Tornado mixer."
    "Mock Bridge — signer compromise allows arbitrary mints|0xc0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff|0xabcdefabcdefabcdefabcdefabcdefabcdefabcd|Five-of-nine multisig had three keys stored on the same SaaS provider. Provider breach → keys leaked → unauthorized cross-chain mint of 4M wMOCK."
    "Mock DEX — liquidity-pool reentrancy nets attacker \$3.4M|0xbabecafebabecafebabecafebabecafebabecafe|0x9876543210987654321098765432109876543210|Reentrancy on the swap callback let attacker double-withdraw before reserves updated. Drained pool in 4 sequential txs over 2 blocks."
    "Mock Vault — broken access control on emergencyWithdraw|0xfeedfacefeedfacefeedfacefeedfacefeedface|0x5555555555555555555555555555555555555555|emergencyWithdraw() lacked onlyOwner modifier. Attacker drained the strategy contract's underlying asset before owner could pause."
    "Mock Lending — bad liquidation incentive lets attacker farm liquidations|0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0|0x4444444444444444444444444444444444444444|Liquidation incentive set to 50% (vs typical 5-10%). Attacker self-liquidated underwater positions for guaranteed profit; \$800k drained over 6 hours before pause."
    "Mock Stable — depeg cascade after collateral oracle returns stale price|0xeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaeaea|0x6666666666666666666666666666666666666666|Oracle staleness check absent. wstMOCK feed froze for 90 minutes during volatility; protocol minted against zombie price → \$2.1M imbalance."
    "Mock Yield — proxy admin grabs implementation slot|0xacacacacacacacacacacacacacacacacacacacac|0x7777777777777777777777777777777777777777|Proxy admin role was on a 1-of-1 multisig managed by a single dev. Compromise → upgraded impl to a drainer → executed in same tx."
)

# --- Helper: whitelist DEV_EOA directly (it holds the whitelistAdmin role) ---
# Post the two-tier governance refactor, addWhitelisted is gated by the
# whitelistAdmin role, not onlyOwner. In dev (DeployDev.s.sol) the dev EOA
# IS the whitelistAdmin, so we can call directly with its key — no timelock
# impersonation needed.
whitelist_dev_eoa() {
    local rpc="$1" proxy="$2"

    local already
    already="$(cast call "$proxy" "isWhitelisted(address)(bool)" "$DEV_EOA" --rpc-url "$rpc" 2>/dev/null || echo "false")"
    if [[ "$already" == "true" ]]; then
        echo "    dev EOA already whitelisted (no-op)"
        return 0
    fi

    cast send "$proxy" "addWhitelisted(address)" "$DEV_EOA" \
        --rpc-url "$rpc" --private-key "$DEV_KEY" >/dev/null

    local now_wl
    now_wl="$(cast call "$proxy" "isWhitelisted(address)(bool)" "$DEV_EOA" --rpc-url "$rpc")"
    if [[ "$now_wl" != "true" ]]; then
        echo "ERROR: failed to whitelist dev EOA (got: $now_wl)" >&2
        return 1
    fi
    echo "    dev EOA whitelisted: $DEV_EOA"
}

# --- Helper: send N mock posts via cast send --------------------------------
seed_posts() {
    local rpc="$1" proxy="$2" n="$3" chain_slug="$4"
    local now_ts
    now_ts="$(cast block latest --field timestamp --rpc-url "$rpc")"

    for i in $(seq 1 "$n"); do
        # Cycle through the catalogue so re-runs don't all post the same thing.
        local idx=$(( (i - 1) % ${#MOCK_POSTS[@]} ))
        IFS='|' read -r title attackers_csv victims_csv note <<< "${MOCK_POSTS[$idx]}"

        # Spread the attackedAt timestamps across the past hour so the feed
        # has a believable spread of "attacked X minutes ago" labels.
        local offset_secs=$(( (i * 600) + (idx * 87) ))   # 10 min steps + jitter
        local attacked_at=$(( now_ts - offset_secs ))

        # Build calldata — `[]` for empty arrays, otherwise comma-list.
        local attackers="[$attackers_csv]"
        local victims="[$victims_csv]"

        # Tag the title so re-runs are visually distinct from prior batches.
        local tagged_title="[$chain_slug #$i] $title"

        cast send "$proxy" \
            "post(string,address[],address[],string,uint64)" \
            "$tagged_title" \
            "$attackers" \
            "$victims" \
            "$note" \
            "$attacked_at" \
            --rpc-url "$rpc" \
            --private-key "$DEV_KEY" \
            >/dev/null

        echo "    [$i/$n] posted: $tagged_title"
    done
}

# --- Main loop --------------------------------------------------------------
echo "════════════════════════════════════════════════════════════════════"
echo " seed-mock-posts (count = $POSTS_PER_CHAIN per chain)"
echo "════════════════════════════════════════════════════════════════════"

for entry in "${CHAINS[@]}"; do
    IFS='|' read -r slug rpc deployed_json <<< "$entry"

    if [[ ! -f "$deployed_json" ]]; then
        echo
        echo "ERROR: $deployed_json not found — run \`make anvil-bootstrap\` first" >&2
        exit 1
    fi

    proxy="$(jq -r .proxy "$deployed_json")"

    echo
    echo "==> $slug ($rpc)"
    echo "    proxy=$proxy"

    # Confirm anvil is reachable.
    if ! cast chain-id --rpc-url "$rpc" >/dev/null 2>&1; then
        echo "ERROR: anvil not reachable at $rpc — run \`make lan-up\` first" >&2
        exit 1
    fi

    whitelist_dev_eoa "$rpc" "$proxy"
    seed_posts "$rpc" "$proxy" "$POSTS_PER_CHAIN" "$slug"

    # Sanity-check the post count moved.
    new_count="$(cast call "$proxy" "postCount()(uint256)" --rpc-url "$rpc" | tr -d '[]\n ')"
    echo "    postCount = $new_count"
done

echo
echo "════════════════════════════════════════════════════════════════════"
echo " ✅ seeded — visit the feed to see them"
echo
echo "    feed:    http://localhost:5173"
echo "    mesh:    http://localhost:4350/graphql"
echo "════════════════════════════════════════════════════════════════════"
