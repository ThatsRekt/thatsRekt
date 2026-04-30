#!/usr/bin/env bash
# =============================================================================
# Idempotently ensure a vite dev server for THIS worktree is running on
# :5173, killing stale instances from other worktrees first.
#
# Why this exists:
#   Multiple thatsRekt worktrees on the same machine each have their
#   own `make lan-up`. The OS lets the first one bind :5173; subsequent
#   `vite` invocations silently fall through to :5174, :5175, etc.
#   That's a recipe for `localhost:5173` serving stale code from a
#   forgotten branch — exactly the failure mode we hit during the
#   archive-feed PR. This script enforces that :5173 belongs to the
#   current worktree, period.
#
# Behavior:
#   1. Find every process listening on $VITE_PORT (default 5173).
#   2. For each: check its CWD. If it isn't this worktree's frontend
#      dir, kill it (loudly, with a one-line note explaining why).
#   3. If our pid-file points at a live process whose CWD does match,
#      no-op.
#   4. Otherwise, start a fresh `pnpm dev:lan` and capture the pid.
#
# Outputs:
#   $VITE_PID_FILE      — pid of the running vite (e.g. /tmp/thatsrekt-vite.pid)
#   $VITE_LOG_FILE      — vite stdout/stderr (e.g. /tmp/thatsrekt-vite.log)
#
# Prereqs: lsof + pnpm + (optionally) procfs-equivalent CWD lookup.
# =============================================================================

set -euo pipefail

VITE_PORT="${VITE_PORT:-5173}"
VITE_PID_FILE="${VITE_PID_FILE:-/tmp/thatsrekt-vite.pid}"
VITE_LOG_FILE="${VITE_LOG_FILE:-/tmp/thatsrekt-vite.log}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"

if [[ ! -d "$FRONTEND_DIR" ]]; then
    echo "ERROR: frontend dir not found at $FRONTEND_DIR" >&2
    exit 1
fi

# --- Helper: process CWD ----------------------------------------------------
# macOS doesn't expose /proc; lsof is the portable way to read a process's
# CWD. Returns empty string if the pid is gone or we can't introspect.
proc_cwd() {
    local pid="$1"
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ {sub(/^n/, ""); print; exit}'
}

# --- 1. Sweep stale listeners on $VITE_PORT --------------------------------
# Build the set of pids holding a LISTEN socket on the port. Skip header
# row + sort/uniq in case the same pid has multiple file descriptors.
PORT_PIDS="$(lsof -ti tcp:"$VITE_PORT" -sTCP:LISTEN 2>/dev/null | sort -u || true)"

for pid in $PORT_PIDS; do
    cwd="$(proc_cwd "$pid")"
    if [[ "$cwd" == "$FRONTEND_DIR" ]]; then
        # This is our own vite (or a vite from this exact worktree). Leave it.
        continue
    fi
    echo "==> killing stale vite on :$VITE_PORT (pid $pid, cwd: ${cwd:-<unknown>})"
    kill "$pid" 2>/dev/null || true
    # Wait briefly for it to release the port.
    for _ in 1 2 3 4 5; do
        if ! lsof -ti tcp:"$VITE_PORT" -sTCP:LISTEN -p "$pid" >/dev/null 2>&1; then break; fi
        sleep 0.5
    done
    # Force-kill if still holding.
    if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
    fi
done

# --- 2. Already running for THIS worktree? ----------------------------------
if [[ -f "$VITE_PID_FILE" ]]; then
    existing_pid="$(cat "$VITE_PID_FILE")"
    if kill -0 "$existing_pid" 2>/dev/null; then
        existing_cwd="$(proc_cwd "$existing_pid")"
        if [[ "$existing_cwd" == "$FRONTEND_DIR" ]]; then
            echo "    vite already running for this worktree (pid $existing_pid)"
            exit 0
        fi
        # pid is alive but in a different cwd — treat as stale, kill it.
        echo "==> pid-file points at vite from another worktree (pid $existing_pid, cwd: ${existing_cwd:-<unknown>}); killing"
        kill "$existing_pid" 2>/dev/null || true
        sleep 0.5
        kill -9 "$existing_pid" 2>/dev/null || true
    fi
    rm -f "$VITE_PID_FILE"
fi

# --- 3. Start fresh ---------------------------------------------------------
echo "==> starting vite for $FRONTEND_DIR on :$VITE_PORT"
cd "$FRONTEND_DIR"
nohup pnpm dev:lan > "$VITE_LOG_FILE" 2>&1 &
VITE_PID=$!
echo "$VITE_PID" > "$VITE_PID_FILE"

# Wait briefly for vite to bind. If it fails to bind 5173, it would
# fall through to 5174 (vite's default behavior), which is exactly the
# failure mode we want to catch — so we verify the new pid is actually
# listening on $VITE_PORT before declaring success.
for _ in 1 2 3 4 5 6 7 8; do
    if lsof -ti tcp:"$VITE_PORT" -sTCP:LISTEN -p "$VITE_PID" >/dev/null 2>&1; then
        echo "    vite started (pid $VITE_PID) — logs at $VITE_LOG_FILE"
        exit 0
    fi
    sleep 0.5
done

echo "ERROR: vite (pid $VITE_PID) did not bind :$VITE_PORT — last log lines:" >&2
tail -20 "$VITE_LOG_FILE" >&2
exit 1
