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

## Quickstart

```bash
# Install deps
pnpm install

# Generate ABI types + TypeORM models from schema.graphql
pnpm codegen

# Compile
pnpm build

# Start Postgres locally
docker compose up -d

# Copy env template, set RPC + contract address + start block
cp .env.example .env
$EDITOR .env

# Apply migrations (first run only — see "Database migrations" below)
pnpm db:create  # generate migration from schema
pnpm db:migrate # apply

# Run the processor (indexes blocks)
pnpm process

# In a separate terminal: start the GraphQL server
pnpm serve
# Open http://localhost:4350/graphql
```

## Configuration

`.env` (see `.env.example`):

| Variable | Purpose |
|----------|---------|
| `RPC_SEPOLIA_HTTP` | EVM RPC endpoint (default: Sepolia public) |
| `CONTRACT_ADDRESS` | The thatsRekt **proxy** address (canonical, identical across chains) |
| `START_BLOCK` | First block to index — typically the proxy's deploy block |
| `DB_*`, `GQL_PORT` | Postgres + GraphQL server ports |

Single-chain in v0.1. Multi-chain support is planned (see `tasks/squid-indexer-plan.md` § Phase 6).

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
