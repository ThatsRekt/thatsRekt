#!/usr/bin/env bash
# =============================================================================
# Reset local dev stack to a fresh, deployed, migrated state.
#
# What this does:
#   1. Stop the relay if running (it points at the OLD contract address).
#   2. Stop the indexer/mesh containers (so we can drop their DBs cleanly).
#   3. Ensure both anvils are up (start if needed) and healthy.
#   4. Re-deploy thatsRekt to anvil-eth + anvil-base. This rewrites
#      contracts/script/anvil/.deployed.<chain>.json with new addresses
#      and start blocks (the proxy address is stable across re-deploys
#      via CREATE2; only the start block changes after each anvil reset).
#   5. Patch indexer/.env with the new CONTRACT_*/START_BLOCK_* values.
#   6. Drop + recreate the per-chain Postgres databases (so the indexer
#      starts cleanly from the new start block — otherwise it'd try to
#      resume from the old block and find nothing matching its memo).
#   7. Run migrations.
#   8. Bring the indexer/mesh services back up.
#   9. If the relay was running before, restart it (re-whitelisted on
#      the fresh contract).
#
# When to run this:
#   - After `make clean` or `docker compose down -v` (volumes wiped).
#   - After bouncing the anvils (in-memory state lost on restart since
#     anvil has no volume mount).
#   - When the indexer is wedged because indexer/.env points at a stale
#     contract address.
#
# Usage:
#   make dev-reset
#
# Prereqs: docker, jq, cast, forge on PATH. The indexer must already
# have a writable .env (copy from .env.example if not). Re-bootstrapping
# is fast (<60s on a warm cache).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INDEXER_DIR="$REPO_ROOT/indexer"
CONTRACTS_DIR="$REPO_ROOT/contracts"
INDEXER_ENV="$INDEXER_DIR/.env"

RELAY_PID_FILE="${RELAY_PID_FILE:-/tmp/thatsrekt-relay.pid}"
RELAY_TOKEN_FILE="${RELAY_TOKEN_FILE:-/tmp/thatsrekt-relay.token}"
RELAY_EOA_KEY_FILE="${RELAY_EOA_KEY_FILE:-/tmp/thatsrekt-relay-eoa.key}"

COMPOSE=(docker compose
  -f "$INDEXER_DIR/docker-compose.yml"
  -f "$INDEXER_DIR/docker-compose.anvil.yml"
  -f "$INDEXER_DIR/docker-compose.lan.yml")

# --- Prereq checks -----------------------------------------------------------
for tool in docker jq cast forge; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: $tool not found on PATH" >&2
        exit 1
    fi
done

if [[ ! -f "$INDEXER_ENV" ]]; then
    echo "ERROR: $INDEXER_ENV not found." >&2
    echo "Copy from $INDEXER_DIR/.env.example and fill in ANVIL_ETH_FORK_URL +" >&2
    echo "ANVIL_BASE_FORK_URL with valid upstream RPCs (see CLAUDE.md)." >&2
    exit 1
fi

echo "════════════════════════════════════════════════════════════════════"
echo " dev-reset"
echo "════════════════════════════════════════════════════════════════════"

# --- 1. Stop relay if running -----------------------------------------------
RELAY_WAS_RUNNING=false
if [[ -f "$RELAY_PID_FILE" ]] && kill -0 "$(cat "$RELAY_PID_FILE")" 2>/dev/null; then
    RELAY_WAS_RUNNING=true
    echo
    echo "==> stopping running relay (will restart against fresh contracts at the end)"
    kill "$(cat "$RELAY_PID_FILE")" 2>/dev/null || true
    rm -f "$RELAY_PID_FILE"
fi

# --- 2. Stop indexer/mesh services ------------------------------------------
echo
echo "==> stopping indexer + mesh services (so we can wipe their DBs)"
"${COMPOSE[@]}" stop \
    processor-anvil-eth processor-anvil-base \
    graphql-anvil-eth graphql-anvil-base \
    mesh 2>/dev/null || true

# --- 3. Ensure anvils + db are up + healthy ---------------------------------
echo
echo "==> ensuring anvils + db are up"
"${COMPOSE[@]}" up -d anvil-eth anvil-base db

echo -n "    waiting for anvil-eth..."
for _ in $(seq 1 60); do
    if curl -sf -X POST http://localhost:8545 \
        -H "Content-Type: application/json" \
        --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
        >/dev/null 2>&1; then
        echo " ok"; break
    fi
    echo -n "."; sleep 1
done

echo -n "    waiting for anvil-base..."
for _ in $(seq 1 60); do
    if curl -sf -X POST http://localhost:8546 \
        -H "Content-Type: application/json" \
        --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
        >/dev/null 2>&1; then
        echo " ok"; break
    fi
    echo -n "."; sleep 1
done

echo -n "    waiting for db..."
for _ in $(seq 1 30); do
    if docker exec indexer-db-1 pg_isready -U postgres >/dev/null 2>&1; then
        echo " ok"; break
    fi
    echo -n "."; sleep 1
done

# --- 4. Re-deploy contracts -------------------------------------------------
echo
echo "==> deploying thatsRekt to anvil-eth"
"$CONTRACTS_DIR/script/anvil/bootstrap.sh" anvil-eth >/dev/null
ETH_PROXY="$(jq -r .proxy "$CONTRACTS_DIR/script/anvil/.deployed.anvil-eth.json")"
ETH_BLOCK="$(jq -r .blockNumber "$CONTRACTS_DIR/script/anvil/.deployed.anvil-eth.json")"
echo "    proxy=$ETH_PROXY block=$ETH_BLOCK"

echo
echo "==> deploying thatsRekt to anvil-base"
ANVIL_RPC=http://localhost:8546 "$CONTRACTS_DIR/script/anvil/bootstrap.sh" anvil-base >/dev/null
BASE_PROXY="$(jq -r .proxy "$CONTRACTS_DIR/script/anvil/.deployed.anvil-base.json")"
BASE_BLOCK="$(jq -r .blockNumber "$CONTRACTS_DIR/script/anvil/.deployed.anvil-base.json")"
echo "    proxy=$BASE_PROXY block=$BASE_BLOCK"

# --- 5. Patch indexer/.env --------------------------------------------------
echo
echo "==> patching indexer/.env with new addresses + start blocks"
sed -i.bak \
    -e "s|^CONTRACT_ANVIL_ETH=.*|CONTRACT_ANVIL_ETH=${ETH_PROXY}|" \
    -e "s|^START_BLOCK_ANVIL_ETH=.*|START_BLOCK_ANVIL_ETH=${ETH_BLOCK}|" \
    -e "s|^CONTRACT_ANVIL_BASE=.*|CONTRACT_ANVIL_BASE=${BASE_PROXY}|" \
    -e "s|^START_BLOCK_ANVIL_BASE=.*|START_BLOCK_ANVIL_BASE=${BASE_BLOCK}|" \
    "$INDEXER_ENV"
rm -f "${INDEXER_ENV}.bak"

# --- 6. Drop + recreate the local indexer DBs -------------------------------
# Also creates any chain DB that init.sql added but the existing pgdata
# volume predates (e.g. you're on a stack where Optimism was added after
# the volume was first initialized). Idempotent.
echo
echo "==> resetting anvil DBs + ensuring all chain DBs exist"
docker exec indexer-db-1 psql -U postgres -c "DROP DATABASE IF EXISTS thatsrekt_anvil_eth;" >/dev/null
docker exec indexer-db-1 psql -U postgres -c "DROP DATABASE IF EXISTS thatsrekt_anvil_base;" >/dev/null
for db in thatsrekt_anvil_eth thatsrekt_anvil_base thatsrekt_sepolia thatsrekt_base thatsrekt_optimism; do
    if ! docker exec indexer-db-1 psql -U postgres -tAc \
            "SELECT 1 FROM pg_database WHERE datname='$db';" | grep -q 1; then
        docker exec indexer-db-1 psql -U postgres -c "CREATE DATABASE $db;" >/dev/null
        echo "    + created $db"
    fi
done

# --- 7. Run migrations ------------------------------------------------------
echo
echo "==> running migrations against the fresh DBs"
"${COMPOSE[@]}" up --no-deps -d migrate-anvil-eth migrate-anvil-base
# `migrate-*` services exit on completion. Wait until both have exited
# successfully before bringing up the long-lived services that depend
# on them.
echo -n "    waiting for migrations..."
for _ in $(seq 1 60); do
    eth_state="$("${COMPOSE[@]}" ps migrate-anvil-eth -a --format '{{.State}}' 2>/dev/null | head -1)"
    base_state="$("${COMPOSE[@]}" ps migrate-anvil-base -a --format '{{.State}}' 2>/dev/null | head -1)"
    if [[ "$eth_state" == "exited" && "$base_state" == "exited" ]]; then
        echo " ok"; break
    fi
    echo -n "."; sleep 1
done

# --- 8. Bring up the rest of the stack --------------------------------------
echo
echo "==> bringing up processors + graphql + mesh"
"${COMPOSE[@]}" up -d \
    processor-anvil-eth processor-anvil-base \
    graphql-anvil-eth graphql-anvil-base \
    mesh

# --- 9. Restart relay if it was running -------------------------------------
if [[ "$RELAY_WAS_RUNNING" == "true" ]]; then
    echo
    echo "==> restarting relay (re-whitelisted on the fresh contract)"
    "$SCRIPT_DIR/start-relay.sh"
fi

# --- Done -------------------------------------------------------------------
echo
echo "════════════════════════════════════════════════════════════════════"
echo " ✅ dev-reset complete"
echo
echo "    anvil-eth proxy:  $ETH_PROXY (block $ETH_BLOCK)"
echo "    anvil-base proxy: $BASE_PROXY (block $BASE_BLOCK)"
if [[ "$RELAY_WAS_RUNNING" == "true" ]]; then
    echo "    relay:            running on :8080 (token in $RELAY_TOKEN_FILE)"
fi
echo
echo "    feed:    http://localhost:5173"
echo "    mesh:    http://localhost:4350/graphql"
echo "════════════════════════════════════════════════════════════════════"
