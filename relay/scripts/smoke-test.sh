#!/usr/bin/env bash
# =============================================================================
# Sub-phase A smoke test for the thatsRekt relay server.
#
# What this exercises end-to-end:
#   1. Spins up a fresh anvil on 127.0.0.1:8545 (chain id 31337).
#   2. Deploys thatsRekt via the existing contracts/script/anvil/bootstrap.sh
#      (DeployDev.s.sol — owner = anvil account 0; proxy goes through a
#      TimelockController).
#   3. Generates a fresh EOA, funds it, impersonates the timelock, and
#      whitelists the EOA.
#   4. Builds and launches the relay with the EOA's private key.
#   5. Sends a valid post.create over websocket, asserts ack/submitted
#      with non-empty tx_hash and post_id.
#   6. Verifies on-chain: postCount() == 1, postTitle(1) == sent title.
#   7. Re-sends the same envelope id and asserts the dedup cache replays
#      the response WITHOUT a second on-chain submission (postCount
#      remains 1).
#   8. Sends a malformed envelope (missing title) and asserts a nack
#      with a clear error.
#
# All temp state (anvil PID, relay PID, log files) lives under a per-run
# tmpdir that is unconditionally cleaned up via trap.
#
# Usage:
#   ./relay/scripts/smoke-test.sh
#
# Prereqs: anvil, cast, forge, jq, go on PATH.
# =============================================================================

set -euo pipefail

# --- locate dirs --------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$RELAY_DIR/.." && pwd)"
CONTRACTS_DIR="$REPO_ROOT/contracts"
DEPLOYED_JSON="$CONTRACTS_DIR/script/anvil/.deployed.anvil-eth.json"

# --- prereq tooling -----------------------------------------------------------
for tool in anvil cast forge jq go; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: $tool not found on PATH" >&2
        exit 1
    fi
done

# --- per-run tmpdir + cleanup -------------------------------------------------
TMPDIR_RUN="$(mktemp -d -t thatsrekt-relay-smoke.XXXXXX)"
ANVIL_PID=""
RELAY_PID=""

cleanup() {
    set +e
    if [[ -n "$RELAY_PID" ]] && kill -0 "$RELAY_PID" 2>/dev/null; then
        kill "$RELAY_PID" 2>/dev/null
        wait "$RELAY_PID" 2>/dev/null
    fi
    if [[ -n "$ANVIL_PID" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
        kill "$ANVIL_PID" 2>/dev/null
        wait "$ANVIL_PID" 2>/dev/null
    fi
    rm -rf "$TMPDIR_RUN"
}
trap cleanup EXIT INT TERM

ANVIL_LOG="$TMPDIR_RUN/anvil.log"
RELAY_LOG="$TMPDIR_RUN/relay.log"
RELAY_BIN="$TMPDIR_RUN/relay"
WSCLIENT_BIN="$TMPDIR_RUN/wsclient"

# --- 1. anvil -----------------------------------------------------------------
ANVIL_PORT=18545
RPC_URL="http://127.0.0.1:${ANVIL_PORT}"
# The smoke test runs an isolated anvil on a non-default port so it can't
# conflict with a long-running anvil from another session (the docker
# anvil-eth + anvil-base setup, or a prior smoke run that leaked).
if lsof -i ":${ANVIL_PORT}" >/dev/null 2>&1; then
    echo "ERROR: port ${ANVIL_PORT} already in use; refusing to clobber an existing service" >&2
    exit 1
fi
echo "==> Starting anvil on $RPC_URL"
anvil --host 127.0.0.1 --chain-id 31337 --port "$ANVIL_PORT" --silent >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!

# Wait for anvil to be ready.
for i in {1..30}; do
    if cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
    if [[ $i -eq 30 ]]; then
        echo "ERROR: anvil did not become ready" >&2
        cat "$ANVIL_LOG" >&2
        exit 1
    fi
done
echo "    anvil up (pid $ANVIL_PID)"

# --- 2. deploy thatsRekt via existing bootstrap -------------------------------
echo "==> Deploying thatsRekt via bootstrap.sh anvil-eth (RPC=$RPC_URL)"
# bootstrap.sh respects ANVIL_RPC env override (see contracts/script/anvil/bootstrap.sh).
( cd "$CONTRACTS_DIR" && ANVIL_RPC="$RPC_URL" bash script/anvil/bootstrap.sh anvil-eth ) >"$TMPDIR_RUN/bootstrap.log" 2>&1
if [[ ! -f "$DEPLOYED_JSON" ]]; then
    echo "ERROR: bootstrap did not produce $DEPLOYED_JSON" >&2
    cat "$TMPDIR_RUN/bootstrap.log" >&2
    exit 1
fi
PROXY="$(jq -r .proxy "$DEPLOYED_JSON")"
TIMELOCK="$(jq -r .timelock "$DEPLOYED_JSON")"
echo "    proxy=$PROXY"
echo "    timelock=$TIMELOCK"

# --- 3. fresh EOA + whitelist via timelock impersonation ----------------------
echo "==> Generating fresh relay EOA + whitelisting via timelock impersonation"
WALLET_OUT="$(cast wallet new --json)"
RELAY_EOA="$(echo "$WALLET_OUT" | jq -r '.[0].address')"
RELAY_KEY="$(echo "$WALLET_OUT" | jq -r '.[0].private_key')"
echo "    relay EOA: $RELAY_EOA"

# Fund the EOA so it can pay gas for the post() tx.
cast rpc anvil_setBalance "$RELAY_EOA" "0x56BC75E2D63100000" --rpc-url "$RPC_URL" >/dev/null  # 100 ETH

# Fund the timelock too (it will need gas to send addWhitelisted).
cast rpc anvil_setBalance "$TIMELOCK" "0x56BC75E2D63100000" --rpc-url "$RPC_URL" >/dev/null

# Impersonate the timelock and call addWhitelisted on the proxy.
# DeployDev wires the proxy's owner to the timelock; addWhitelisted is
# onlyOwner. From() must be the timelock for the call to succeed.
cast rpc anvil_impersonateAccount "$TIMELOCK" --rpc-url "$RPC_URL" >/dev/null
cast send "$PROXY" "addWhitelisted(address)" "$RELAY_EOA" \
    --from "$TIMELOCK" --unlocked --rpc-url "$RPC_URL" >/dev/null
cast rpc anvil_stopImpersonatingAccount "$TIMELOCK" --rpc-url "$RPC_URL" >/dev/null

WHITELISTED="$(cast call "$PROXY" "isWhitelisted(address)(bool)" "$RELAY_EOA" --rpc-url "$RPC_URL")"
if [[ "$WHITELISTED" != "true" ]]; then
    echo "ERROR: relay EOA was not whitelisted (got: $WHITELISTED)" >&2
    exit 1
fi
echo "    whitelisted: $WHITELISTED"

# --- 4. build relay + wsclient ------------------------------------------------
echo "==> Building relay + wsclient"
( cd "$RELAY_DIR" && go build -o "$RELAY_BIN" ./cmd/relay )
( cd "$RELAY_DIR" && go build -o "$WSCLIENT_BIN" ./scripts/wsclient )

# --- 5. launch relay ----------------------------------------------------------
PROVIDER_TOKEN="dev-secret-$$"
RELAY_PORT=18080
RELAY_URL="ws://127.0.0.1:${RELAY_PORT}/ws"
echo "==> Launching relay on :$RELAY_PORT (chain anvil-eth, contract $PROXY)"
RELAY_PROVIDER_TOKEN="$PROVIDER_TOKEN" \
RELAY_PRIVATE_KEY="$RELAY_KEY" \
RELAY_RPC_URL="$RPC_URL" \
RELAY_CONTRACT_ADDRESS="$PROXY" \
RELAY_CHAIN_ID="31337" \
RELAY_CHAIN_NAME="anvil-eth" \
RELAY_LISTEN_ADDR=":${RELAY_PORT}" \
RELAY_RECEIPT_TIMEOUT="30s" \
"$RELAY_BIN" >"$RELAY_LOG" 2>&1 &
RELAY_PID=$!

# Wait for the relay's HTTP listener.
for i in {1..30}; do
    if curl -sf "http://127.0.0.1:${RELAY_PORT}/healthz" >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
    if [[ $i -eq 30 ]]; then
        echo "ERROR: relay did not become ready" >&2
        cat "$RELAY_LOG" >&2
        exit 1
    fi
done
echo "    relay up (pid $RELAY_PID)"

# --- 6. send a valid post.create ---------------------------------------------
TITLE="Aave drainer detected"
ATTACKER="0x000000000000000000000000000000000000DEAd"
VICTIM="0x000000000000000000000000000000000000bEEF"
NOTE="smoke-test note"
ATTACK_AT="$(date -u +%s)"
MSG_ID="msg-smoke-$$"

REQ="$(jq -n \
    --arg id "$MSG_ID" \
    --arg title "$TITLE" \
    --arg note "$NOTE" \
    --arg attacker "$ATTACKER" \
    --arg victim "$VICTIM" \
    --argjson attacked_at "$ATTACK_AT" \
    '{
        type: "post.create",
        id: $id,
        timestamp: "2026-04-27T22:00:00Z",
        payload: {
            chains: ["anvil-eth"],
            title: $title,
            attackers: [$attacker],
            victims: [$victim],
            note: $note,
            attacked_at: $attacked_at
        }
    }')"

echo "==> Sending valid post.create (msg_id=$MSG_ID)"
ACK="$(echo "$REQ" | "$WSCLIENT_BIN" -url "$RELAY_URL" -token "$PROVIDER_TOKEN")"
echo "    ack: $ACK"

ACK_TYPE="$(echo "$ACK" | jq -r .type)"
ACK_STATUS="$(echo "$ACK" | jq -r '.results[0].status')"
ACK_TXHASH="$(echo "$ACK" | jq -r '.results[0].tx_hash')"
ACK_POSTID="$(echo "$ACK" | jq -r '.results[0].post_id')"

if [[ "$ACK_TYPE" != "ack" ]]; then
    echo "ERROR: expected type=ack, got $ACK_TYPE (full: $ACK)" >&2
    exit 1
fi
if [[ "$ACK_STATUS" != "submitted" ]]; then
    echo "ERROR: expected status=submitted, got $ACK_STATUS (full: $ACK)" >&2
    exit 1
fi
if [[ -z "$ACK_TXHASH" || "$ACK_TXHASH" == "null" ]]; then
    echo "ERROR: tx_hash empty (full: $ACK)" >&2
    exit 1
fi
if [[ -z "$ACK_POSTID" || "$ACK_POSTID" == "null" ]]; then
    echo "ERROR: post_id empty (full: $ACK)" >&2
    exit 1
fi
echo "    submitted ok (tx=$ACK_TXHASH post_id=$ACK_POSTID)"

# --- 7. on-chain assertions ---------------------------------------------------
POST_COUNT="$(cast call "$PROXY" "postCount()(uint256)" --rpc-url "$RPC_URL")"
# `cast call` on uint256 returns a decimal string; on newer foundry versions
# it returns "1 [1e0]" — strip annotation.
POST_COUNT_NUM="${POST_COUNT%% *}"
if [[ "$POST_COUNT_NUM" != "1" ]]; then
    echo "ERROR: postCount expected 1, got $POST_COUNT" >&2
    exit 1
fi
ON_CHAIN_TITLE="$(cast call "$PROXY" "postTitle(uint256)(string)" 1 --rpc-url "$RPC_URL")"
# strip surrounding quotes that cast wraps strings in
ON_CHAIN_TITLE_TRIMMED="${ON_CHAIN_TITLE#\"}"
ON_CHAIN_TITLE_TRIMMED="${ON_CHAIN_TITLE_TRIMMED%\"}"
if [[ "$ON_CHAIN_TITLE_TRIMMED" != "$TITLE" ]]; then
    echo "ERROR: postTitle expected $TITLE, got $ON_CHAIN_TITLE_TRIMMED" >&2
    exit 1
fi
echo "    on-chain postCount=1, postTitle(1)=\"$ON_CHAIN_TITLE_TRIMMED\""

# --- 8. dedup: replay same id, must NOT submit a second tx -------------------
echo "==> Replay same msg_id; expect cached ack and no new on-chain post"
ACK2="$(echo "$REQ" | "$WSCLIENT_BIN" -url "$RELAY_URL" -token "$PROVIDER_TOKEN")"
ACK2_TYPE="$(echo "$ACK2" | jq -r .type)"
ACK2_TXHASH="$(echo "$ACK2" | jq -r '.results[0].tx_hash')"
if [[ "$ACK2_TYPE" != "ack" ]]; then
    echo "ERROR: replay expected type=ack, got $ACK2_TYPE (full: $ACK2)" >&2
    exit 1
fi
if [[ "$ACK2_TXHASH" != "$ACK_TXHASH" ]]; then
    echo "ERROR: replay tx_hash changed (was $ACK_TXHASH, now $ACK2_TXHASH)" >&2
    exit 1
fi
POST_COUNT2="$(cast call "$PROXY" "postCount()(uint256)" --rpc-url "$RPC_URL")"
POST_COUNT2_NUM="${POST_COUNT2%% *}"
if [[ "$POST_COUNT2_NUM" != "1" ]]; then
    echo "ERROR: dedup failed; postCount went to $POST_COUNT2_NUM" >&2
    exit 1
fi
echo "    dedup ok (postCount stayed at 1, tx_hash echoed)"

# --- 9. malformed message: missing title --------------------------------------
echo "==> Sending malformed (missing title) — expect nack"
BAD="$(jq -n \
    --arg id "msg-bad-$$" \
    --argjson attacked_at "$ATTACK_AT" \
    '{
        type: "post.create",
        id: $id,
        timestamp: "2026-04-27T22:00:00Z",
        payload: {
            chains: ["anvil-eth"],
            title: "",
            attackers: [],
            victims: [],
            note: "",
            attacked_at: $attacked_at
        }
    }')"
NACK="$(echo "$BAD" | "$WSCLIENT_BIN" -url "$RELAY_URL" -token "$PROVIDER_TOKEN")"
echo "    nack: $NACK"
NACK_TYPE="$(echo "$NACK" | jq -r .type)"
NACK_ERROR="$(echo "$NACK" | jq -r .error)"
if [[ "$NACK_TYPE" != "nack" ]]; then
    echo "ERROR: expected type=nack, got $NACK_TYPE" >&2
    exit 1
fi
if [[ -z "$NACK_ERROR" || "$NACK_ERROR" == "null" ]]; then
    echo "ERROR: nack must populate error" >&2
    exit 1
fi
case "$NACK_ERROR" in
    *title*) ;; # expected
    *)
        echo "ERROR: nack error should mention title, got: $NACK_ERROR" >&2
        exit 1
        ;;
esac
echo "    malformed correctly rejected"

# --- success ------------------------------------------------------------------
echo
echo "==> SMOKE TEST PASSED"
echo "    relay log: $RELAY_LOG (kept until cleanup; tail above on failure)"
