# thatsRekt Subsquid Indexer

TypeScript indexer of `thatsRekt` contract events. Each configured chain has its own logical Postgres database, processor, and internal GraphQL service; Mesh is the unified public GraphQL read surface.

## Stack

- **Processor:** Portal batches (`@subsquid/batch-processor` + `@subsquid/evm-stream`) for Production Chains; explicit RPC only for Local Anvil Forks and testnets.
- **Storage:** Postgres (managed via TypeORM)
- **API:** GraphQL via `@subsquid/graphql-server` (auto-generated from `schema.graphql`)
- **Language:** TypeScript

## Prereqs

- Node.js ≥ 22
- pnpm ≥ 10
- Docker (for the local Postgres dev container)

## Quickstart — full Docker stack

One Postgres process hosts isolated logical databases for the Compose chain services. The exact slug-to-database map is: `anvil-eth` → `thatsrekt_anvil_eth`, `anvil-base` → `thatsrekt_anvil_base`, `sepolia` → `thatsrekt_sepolia`, `ethereum` → `thatsrekt_ethereum`, `base` → `thatsrekt_base`, `optimism` → `thatsrekt_optimism`, `arbitrum` → `thatsrekt_arbitrum`, `bsc` → `thatsrekt_bsc`, and `polygon` → `thatsrekt_polygon`. Each has `migrate-<slug>`, `processor-<slug>`, and `graphql-<slug>` services; `mesh` stitches configured registry GraphQL services into the unified public read surface on port `4350`.

```bash
cp .env.example .env
$EDITOR .env  # set contracts/start blocks and Portal configuration for Production Chains
docker compose up -d --build
```

| Service | Role | Listens on |
|---|---|---|
| `db` | Postgres 16; provisions the exact databases listed above on first boot. | `127.0.0.1:5432` |
| `migrate-<slug>` | One-shot migrations for that slug's mapped logical database. | n/a |
| `processor-<slug>` | Long-running registry processor for one slug. | n/a |
| `graphql-<slug>` | Internal registry GraphQL service for one slug. | Compose network only |
| `mesh` | Unified registry GraphQL gateway over configured internal upstreams. | Compose network port `4350` |

```bash
docker compose ps
docker compose logs -f processor-base
docker compose down  # stops services but preserves the database volume
```

### Running a single chain (regression / development)

```bash
docker compose up -d db migrate-base processor-base graphql-base
```

The same pattern applies to any Compose slug. Other services remain stopped; their mapped databases remain isolated until started.

### Querying a registry GraphQL service

Mesh is the unified read surface. For local upstream diagnosis, query an individual internal `graphql-<slug>` service through `docker compose exec`:

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
cp .env.example .env       # for CHAIN=base, ensure DB_HOST=localhost and DB_NAME=thatsrekt_base
pnpm db:migrate
CHAIN=base pnpm process    # one terminal
pnpm serve                 # another — http://localhost:4350/graphql
```

## Configuration

The required `CHAIN` environment variable selects one registry processor instance. [`src/chains.ts`](./src/chains.ts) is the source of truth for all supported slugs, chain IDs, source configuration, finality settings, and chain-specific environment variable names.

`CHAIN` accepts `anvil-eth`, `anvil-base`, `sepolia`, `ethereum`, `base`, `base-sepolia`, `optimism`, `arbitrum`, `bsc`, or `polygon`; invalid or absent values fail fast. Only the selected chain's configuration is required at runtime. The six Production Chains are separate processor instances; testnets and Local Anvil Forks remain separate environments.

### Portal configuration

The six Production Chains (`ethereum`, `base`, `arbitrum`, `optimism`, `bsc`,
and `polygon`) use their exact Portal Dataset Endpoint through a generic
per-container `PORTAL_URL`; the selected dataset is appended at runtime.
`PORTAL_API_KEY` is optional and is sent only as `x-api-key`. Empty or absent
keys send no authentication header.

Production historical ingestion never falls back to chain RPC or the legacy
archive gateway. `anvil-eth`, `anvil-base`, `sepolia`, and `base-sepolia` stay
explicit RPC-only and do not require Portal configuration.

### Deterministic Portal proof

The non-production Base fixture freezes all six comparison heights, checks the
Moonwell post-5 transaction at block `50,517,211`, and resumes at `50,527,337`
without duplicating entities or rewinding its durable fixture checkpoint:

```bash
pnpm build
pnpm test:portal-integrity
```

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

### Destructive local-only reset

Only for an isolated local development volume that may be discarded; **never** run this against production, a preserved database, or any state used for migration proof:

```bash
pnpm db:reset
# LOCAL DEVELOPMENT ONLY: deletes the local Compose Postgres volume.
docker compose down -v
docker compose up -d
pnpm db:migrate
```

## Hosting

Production registry processing is self-hosted as separate Node 22 chain services, with Mesh as the unified public read surface. Each Production Chain uses a Portal Dataset Endpoint for historical blocks; Local Anvil Forks and testnets remain explicit RPC-only development paths.

## Plan

Implementation plan and design rationale: [`tasks/multichain-testnet-plan.md`](../tasks/multichain-testnet-plan.md) (current) and [`tasks/squid-indexer-plan.md`](./tasks/squid-indexer-plan.md) (predecessor).
