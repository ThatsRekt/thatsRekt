# thatsRekt — full-stack LAN walkthrough

End-to-end run of the dual-anvil + Mesh + frontend stack on your laptop, exposed to the LAN so teammates and other devices on the same Wi-Fi can hit it.

The stack:

```
                              ┌──────────────────────────────────┐
   external LAN devices  ────→│  http://<host-lan-ip>:5173       │  frontend (vite)
                              ├──────────────────────────────────┤
   external LAN devices  ────→│  http://<host-lan-ip>:4350/graphql│  Mesh gateway
                              ├──────────────────────────────────┤
   external LAN devices  ────→│  http://<host-lan-ip>:8545        │  anvil-eth RPC
   external LAN devices  ────→│  http://<host-lan-ip>:8546        │  anvil-base RPC
                              ├──────────────────────────────────┤
                              │  postgres :5432  (loopback only)  │
                              │  squid GraphQLs (compose-internal)│
                              └──────────────────────────────────┘
```

## Prerequisites

- Docker + docker compose
- Foundry (`anvil`, `cast`, `forge`) on PATH
- Node.js ≥ 20, pnpm ≥ 10
- Routeme.sh API key (or any RPC) for forking Ethereum + Base mainnet

## One-time setup

```bash
cd indexer
cp .env.example .env
$EDITOR .env
# Fill in:
#   ANVIL_ETH_FORK_URL=https://lb.routeme.sh/rpc/1/<key>
#   ANVIL_BASE_FORK_URL=https://lb.routeme.sh/rpc/8453/<key>
# (sepolia + base real-chain entries are optional — set MESH_CHAINS to
#  `anvil-eth,anvil-base` to keep things local-only)

cd ../mesh && pnpm install
cd ../frontend && pnpm install
cd ../indexer && pnpm install
```

## Standard flow

```bash
# 1. Bring up databases + anvils + bootstrap thatsRekt onto each
make -C ops anvil-bootstrap

# 2. Copy the printed CONTRACT_* and START_BLOCK_* values into indexer/.env

# 3. Bring up the full LAN stack
make -C ops lan-up
```

`lan-up` brings up:

- Postgres
- Both anvil RPCs (`anvil-eth` on :8545, `anvil-base` on :8546) — bound to `0.0.0.0`
- 4× squid migration jobs (one-shot, exit 0)
- 4× squid processors
- 4× squid GraphQL servers (compose-internal only)
- Mesh gateway on :4350 — bound to `0.0.0.0`
- Frontend dev server on :5173 — bound to `0.0.0.0`

It then prints the LAN URLs to share:

```
═══════════════════════════════════════════════════════════════
  thatsRekt LAN endpoints:

    Frontend:   http://192.168.1.42:5173
    GraphQL:    http://192.168.1.42:4350/graphql
    Anvil eth:  http://192.168.1.42:8545
    Anvil base: http://192.168.1.42:8546
═══════════════════════════════════════════════════════════════
```

Visit `http://<host-lan-ip>:5173` from any device on the same Wi-Fi. The frontend computes its GraphQL endpoint from `window.location.hostname` so the same build works for `localhost` access AND LAN access AND eventual public hosting — no rebuild required.

## What's exposed vs. what's hidden

| Service | Bind | Why |
|---|---|---|
| `mesh` (`:4350`) | `0.0.0.0` | The single public GraphQL surface — read-only, public-good |
| Frontend dev (`:5173`) | `0.0.0.0` | Public-good UI |
| `anvil-eth` (`:8545`), `anvil-base` (`:8546`) | `0.0.0.0` | Useful for `cast` / wallet from LAN devices |
| `postgres` (`:5432`) | `127.0.0.1` (loopback) | DB has no business on the LAN |
| Squid GraphQLs (`:4351`–`:4354`) | compose-internal only | Mesh consumes them; nobody else should |

`make -C ops lan-up` automatically applies `docker-compose.lan.yml` which moves Mesh + anvils to `0.0.0.0`. Without that overlay, services stay on `127.0.0.1`.

## Common operations

```bash
make -C ops lan-info        # print LAN IP + URLs anytime
make -C ops anvil-reset     # nuke anvils + re-deploy + re-index
make -C ops lan-down        # stop everything (keep volumes)
make -C ops clean           # stop + wipe Postgres volume + remove .deployed.*.json
make -C ops help            # full target list
```

## Troubleshooting

- **Can't reach LAN endpoints from another device?** macOS firewall blocks new inbound ports by default. Allow Docker + node in *System Settings → Network → Firewall → Options*.
- **Frontend connects to wrong endpoint?** It computes from `window.location.hostname`. If you visited via `localhost` from the host machine, it'll try `http://localhost:4350/graphql`. Visit via the LAN IP (`http://<host-lan-ip>:5173`) instead.
- **Anvil won't start (`ANVIL_ETH_FORK_URL must be set`)?** Set both `ANVIL_ETH_FORK_URL` and `ANVIL_BASE_FORK_URL` in `indexer/.env`.
- **Postgres reachable from LAN?** Shouldn't be. Confirm with `nc -vz <host-lan-ip> 5432` from another device — should refuse. If it accepts, your overlay is misconfigured.

## Production deploy

Out of scope for this stack. The compose files are dev-only — production targets (AWS / SQD Cloud) are tracked in `tasks/multichain-testnet-plan.md`.
