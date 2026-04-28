# thatsRekt Subsquid Indexer

TypeScript indexer of `thatsRekt` contract events. Persists state into Postgres and exposes a GraphQL API for the upcoming frontend and any external consumers.

## Stack

- **Indexer:** [Subsquid](https://docs.sqd.ai/) Squid SDK (`@subsquid/evm-processor` + `@subsquid/typeorm-store`)
- **Storage:** Postgres (managed via TypeORM)
- **API:** GraphQL via `@subsquid/graphql-server` (auto-generated from `schema.graphql`)
- **Language:** TypeScript

## Prereqs

- Node.js ≥ 20
- pnpm ≥ 10
- Docker (for the local Postgres dev container)

## Quickstart — full Docker stack

The indexer is sovereign-per-chain: one Postgres process holds one logical
database per chain (`thatsrekt_anvil`, `thatsrekt_sepolia`, `thatsrekt_base`),
and each chain gets its own processor + GraphQL service from the same image.
Squid GraphQL ports are **compose-internal only** — Phase 5 of the multichain
plan introduces a Mesh gateway as the single public surface.

```bash
cp .env.example .env
$EDITOR .env  # fill in RPC + contract + start-block for each chain you want indexed
docker compose up -d --build
```

What that brings up:

| Service | Role | Listens on |
|---|---|---|
| `db` | Postgres 16. Provisions `thatsrekt_anvil` / `thatsrekt_sepolia` / `thatsrekt_base` from `init.sql` on first boot. | `127.0.0.1:5432` (host loopback only) |
| `migrate-{chain}` | One-shot — applies migrations to `thatsrekt_{chain}`, then exits. | n/a |
| `processor-{chain}` | Long-running — indexes `{chain}` into `thatsrekt_{chain}`. | n/a |
| `graphql-{chain}` | Squid GraphQL on internal port — **not** exposed to the host. | compose net only: `4351` (anvil), `4352` (sepolia), `4353` (base) |

```bash
docker compose ps                          # status of all services
docker compose logs -f processor-base      # tail one chain's processor
docker compose down                        # stop, keep data volume
docker compose down -v                     # stop + wipe pgdata (forces init.sql to re-run)
```

### Running a single chain (regression / dev)

```bash
docker compose up -d db migrate-base processor-base graphql-base
```

Same pattern for `anvil` or `sepolia`. The other chains' services stay
stopped; their databases exist but are unused until those services run.

### Talking to a squid GraphQL endpoint (before Phase 5 / Mesh)

The squid GraphQL ports are compose-internal. Until Phase 5 introduces the
public Mesh gateway, query a squid directly via `docker compose exec`:

```bash
docker compose exec graphql-base sh -c \
  'wget -qO- --post-data="{\"query\":\"{ posts(limit:5) { id } }\"}" \
   --header="Content-Type: application/json" \
   http://localhost:4353/graphql'
```

## Local dev (without Docker for the indexer)

If you'd rather run a single processor + api on the host while only Postgres
lives in Docker:

```bash
docker compose up -d db
pnpm install
pnpm codegen
pnpm build
cp .env.example .env       # ensure DB_HOST=localhost, DB_NAME=thatsrekt_<chain>
pnpm db:migrate
CHAIN=base pnpm process    # one terminal
pnpm serve                 # another — http://localhost:4350/graphql
```

## Configuration

The indexer is **multichain-ready**: a single `CHAIN` env (one of `anvil` / `sepolia` / `base`) selects which chain a processor instance indexes. The chain registry at [`src/chains.ts`](./src/chains.ts) is the source of truth — chain ids, gateway URLs, finality settings, and per-chain env var names are all declared there. Adding a new chain is a registry entry plus a matching env block.

`.env` (see `.env.example`):

| Variable | Purpose |
|----------|---------|
| `CHAIN` | Which chain this processor instance is for: `anvil` \| `sepolia` \| `base`. Default: `base`. |
| `RPC_BASE_HTTP` / `CONTRACT_BASE` / `START_BLOCK_BASE` | Base mainnet config. RPC pattern: `https://lb.routeme.sh/rpc/8453/{api-key}` (key in DAMM secrets — never commit). |
| `RPC_SEPOLIA_HTTP` / `CONTRACT_SEPOLIA` / `START_BLOCK_SEPOLIA` | Ethereum Sepolia config (filled in once Phase 3 deploys to Sepolia). |
| `RPC_ANVIL_HTTP` / `CONTRACT_ANVIL` / `START_BLOCK_ANVIL` | Local Anvil fork (filled in by Phase 4 bootstrap script). |
| `DB_*`, `GQL_PORT` | Postgres + GraphQL server ports. |

Only the block matching `CHAIN` is required at runtime. Other blocks can stay blank.

The full multichain stack (parallel processors per chain, Mesh gateway, frontend chain filter) lands in Phases 2-7 — see [`tasks/multichain-testnet-plan.md`](../tasks/multichain-testnet-plan.md).

## Schema

See [`schema.graphql`](./schema.graphql). Entities:

| Entity | Purpose |
|--------|---------|
| `Whitelister` | A whitelisted address (poster + voter) |
| `Post` | A hack alert post with current state |
| `Address` | Aggregate per-address (`attackerScore`, `attackerAppearances`, `isVictim`) — mirrors on-chain views |
| `PostAttacker` / `PostVictim` | Junction entities for many-to-many post ↔ address |
| `Vote` | Historical record of every vote action (up, down, unvote) |
| `WhitelistChange` | Whitelist add/remove history |
| `Edit` | Note amendments + attacker/victim additions |
| `Upgrade` | Proxy upgrade history |
| `OwnershipChange` | Ownership transfer history |

## Sample queries

Top attackers by score:

```graphql
{
  addresses(orderBy: attackerScore_DESC, limit: 10) {
    id
    attackerScore
    attackerAppearances
  }
}
```

Live victims (currently flagged):

```graphql
{
  addresses(where: { isVictim_eq: true }) {
    id
    victimActivePostCount
  }
}
```

Recent posts with attackers:

```graphql
{
  posts(orderBy: createdAtBlock_DESC, limit: 10, where: { removed_eq: false }) {
    id
    poster { id }
    attackedAt
    note
    netScore
    attackerLinks {
      address { id attackerScore }
    }
  }
}
```

## Database migrations

Squid uses TypeORM migrations under `db/migrations/` to keep the schema consistent with `schema.graphql`. After **any** change to `schema.graphql`:

```bash
pnpm codegen        # regenerate model files
pnpm build          # compile
pnpm db:create      # generate a new migration from the schema diff
pnpm db:migrate     # apply
```

For a clean reset:

```bash
pnpm db:reset            # revert all migrations
docker compose down -v   # nuke postgres volume
docker compose up -d
pnpm db:migrate
```

## Hosting

**Local development only** for now. Production hosting (self-hosted on AWS, or one-squid-per-chain on SQD Cloud) is a future workstream — see [`tasks/multichain-testnet-plan.md`](../tasks/multichain-testnet-plan.md).

## Plan

Implementation plan and design rationale: [`tasks/multichain-testnet-plan.md`](../tasks/multichain-testnet-plan.md) (current) and [`tasks/squid-indexer-plan.md`](./tasks/squid-indexer-plan.md) (predecessor).
