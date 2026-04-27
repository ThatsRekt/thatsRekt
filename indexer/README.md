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

The whole indexer (postgres + migrations + processor + GraphQL API) runs in Docker. Single command from a clean checkout:

```bash
cp .env.example .env
$EDITOR .env  # set CONTRACT_ADDRESS + START_BLOCK once the contract is deployed
docker compose up -d --build
```

What that brings up:

| Service | Image | Role |
|---------|-------|------|
| `db` | `postgres:16-alpine` | Postgres on port 5432 |
| `migrate` | `indexer-migrate` (built) | One-shot — applies committed migrations against the fresh db, then exits |
| `processor` | `indexer-processor` (built) | Long-running — indexes blocks |
| `api` | `indexer-api` (built) | GraphQL server on port 4350 |

GraphQL endpoint: <http://localhost:4350/graphql>.

Image size: ~204 MB per service (alpine + Node 20 + production node_modules + compiled JS).

```bash
docker compose ps                # check status
docker compose logs -f processor # tail processor logs
docker compose logs -f api       # tail api logs
docker compose down              # stop, keep volume
docker compose down -v           # stop and wipe data
```

## Local dev (without Docker for the indexer)

If you'd rather run the processor + api on the host while only Postgres lives in Docker:

```bash
docker compose up -d db
pnpm install
pnpm codegen
pnpm build
cp .env.example .env  # ensure DB_HOST=localhost
pnpm db:migrate
pnpm process    # one terminal
pnpm serve      # another — http://localhost:4350/graphql
```

## Configuration

`.env` (see `.env.example`):

| Variable | Purpose |
|----------|---------|
| `RPC_BASE_HTTP` | Base mainnet RPC endpoint. Default points at routeme.sh (load-balanced multi-provider). Pattern: `https://lb.routeme.sh/rpc/{chainId}/{api-key}` — Base = chainId `8453`. The api-key lives in DAMM's secrets store — never commit it. |
| `CONTRACT_ADDRESS` | The thatsRekt **proxy** address (canonical, identical across chains) |
| `START_BLOCK` | First block to index — typically the proxy's deploy block |
| `DB_*`, `GQL_PORT` | Postgres + GraphQL server ports |

Single-chain on **Base mainnet** in v0.1. Multi-chain support is planned (see `tasks/squid-indexer-plan.md` § Phase 6).

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

**Phase 1-5 scope:** local development only. Production hosting (single VPS or AWS) is a future workstream — see `tasks/squid-indexer-plan.md` § Phase 7.

When the contract is deployed to mainnet, set `CONTRACT_ADDRESS` + `START_BLOCK` accordingly and run the processor against the production RPC.

## Plan

Implementation plan and design rationale: [`tasks/squid-indexer-plan.md`](./tasks/squid-indexer-plan.md).
