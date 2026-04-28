#!/usr/bin/env bash
# =============================================================================
# Anvil reset — wipes one chain's Anvil state, drops + recreates its
# database, restarts the Anvil container, and re-runs bootstrap.sh.
# =============================================================================
# Usage:
#   reset.sh anvil-eth      # reset just the eth fork
#   reset.sh anvil-base     # reset just the base fork
#   reset.sh                # reset both (eth then base)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INDEXER_DIR="$(cd "$SCRIPT_DIR/../../../indexer" && pwd)"
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.anvil.yml)

reset_one() {
    local chain="$1"
    local db
    case "$chain" in
        anvil-eth)  db=thatsrekt_anvil_eth ;;
        anvil-base) db=thatsrekt_anvil_base ;;
        *) echo "ERROR: unknown chain \"$chain\"" >&2; exit 64 ;;
    esac

    echo "==> Resetting $chain"
    cd "$INDEXER_DIR"

    docker compose "${COMPOSE_FILES[@]}" stop \
        "$chain" "migrate-$chain" "processor-$chain" "graphql-$chain" 2>/dev/null || true
    docker compose "${COMPOSE_FILES[@]}" rm -fv "$chain" 2>/dev/null || true

    echo "    dropping + recreating $db"
    docker compose exec -T db psql -U postgres -c "DROP DATABASE IF EXISTS $db; CREATE DATABASE $db;"

    echo "    restarting $chain"
    docker compose "${COMPOSE_FILES[@]}" up -d "$chain"

    echo "    waiting for healthcheck"
    for _ in $(seq 1 30); do
        if docker compose ps "$chain" | grep -q "healthy"; then break; fi
        sleep 1
    done

    "$SCRIPT_DIR/bootstrap.sh" "$chain"
}

if [[ -z "${1:-}" ]]; then
    reset_one anvil-eth
    reset_one anvil-base
else
    reset_one "$1"
fi
