# donations-indexer

Subsquid processor watching native-coin and allowlisted ERC20 donations to the `thatsrekt.eth` Safe across Ethereum, Base, Arbitrum One, Optimism, BNB Chain, and Polygon. It persists donation rows to the dedicated `thatsrekt_donations` Postgres database; Mesh reads that database directly rather than through a Squid GraphQL server.

## Stack

- **Processor:** Subsquid `@subsquid/evm-processor` with a hand-rolled `HotDatabase<void>`.
- **Storage:** Postgres 16 (`donation` plus `donations_indexer_status_v2`, keyed by chain ID, for cursor state).
- **Language:** TypeScript compiled to CJS via `tsc`.
- **Runtime:** Node 20.

## Scope

- Native-coin and allowlisted ERC20 transfers to the current `thatsrekt.eth` donation recipient across Ethereum, Base, Arbitrum One, Optimism, BNB Chain, and Polygon.
- Direct transfers only; internal CALL traces are not indexed.

## Quickstart — host development (processor + Postgres in Docker)

```bash
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
bun install
bun run build
cp .env.example .env
# Set CHAIN_SLUG, the selected chain's RPC and start-block variables, and DONATIONS_DB_URL.
bun run process
```

## Configuration

`CHAIN_SLUG` is required and selects one of `ethereum`, `base`, `arbitrum`, `optimism`, `bsc`, or `polygon`. The selected entry in `src/chainConfig.ts` determines its required RPC variable and optional start-block override:

| `CHAIN_SLUG` | Required RPC variable | Optional start-block override |
|---|---|---|
| `ethereum` | `RPC_ETHEREUM_HTTP` | `START_BLOCK_ETHEREUM` |
| `base` | `RPC_BASE_HTTP` | `START_BLOCK_BASE` |
| `arbitrum` | `RPC_ARBITRUM_HTTP` | `START_BLOCK_ARBITRUM` |
| `optimism` | `RPC_OPTIMISM_HTTP` | `START_BLOCK_OPTIMISM` |
| `bsc` | `RPC_BSC_HTTP` | `START_BLOCK_BSC` |
| `polygon` | `RPC_POLYGON_HTTP` | `START_BLOCK_POLYGON` |

`DONATIONS_DB_URL` is required. `ENS_RPC_URL`, `DONEE_OVERRIDE`, `GATEWAY_URL`, and `FINALITY_CONFIRMATION` are optional operational overrides; `GATEWAY_URL` is omitted for local RPC-only use. The current runtime remains Node 20. Portal variable names and Node 22 documentation remain deferred until the runtime contract is implemented.

## Testing

All tests require both `TEST_DB_URL` **and** `TEST_SUPERUSER_URL` to be set (or rely on the defaults below). The superuser URL is used to `CREATE DATABASE` if the test DB does not yet exist.

| Variable | Default | Purpose |
|---|---|---|
| `TEST_DB_URL` | `postgres://postgres:postgres@localhost:5432/donations_test` | Test database connection string |
| `TEST_SUPERUSER_URL` | `postgres://postgres:postgres@localhost:5432/postgres` | Superuser connection used to bootstrap the test DB |
| `TEST_ERC20_DB_URL` | `postgres://postgres:postgres@localhost:5432/donations_erc20_test` | Separate test DB for ERC20 e2e (avoids table collisions with native e2e) |
| `FORK_URL` | — | Ethereum archive RPC for the ERC20 e2e mainnet fork. Falls back to `RPC_ETHEREUM_HTTP`. Required for `processor.erc20.e2e.test.ts`. |

```bash
# Unit tests (no infrastructure needed):
bun test test/donationMapper.test.ts test/tokenAllowlist.test.ts

# Store e2e (real Postgres required):
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
TEST_SUPERUSER_URL=postgres://postgres:postgres@localhost:5432/postgres \
  bun test test/donationStore.e2e.test.ts

# Processor e2e — native ETH (real Postgres + anvil required):
bun run build
TEST_DB_URL=postgres://postgres:postgres@localhost:5432/donations_test \
TEST_SUPERUSER_URL=postgres://postgres:postgres@localhost:5432/postgres \
  bun test test/processor.e2e.test.ts

# Processor e2e — ERC20 (real Postgres + anvil mainnet fork required):
bun run build
TEST_DB_URL=postgres://postgres:postgres@localhost:5432/donations_test \
TEST_SUPERUSER_URL=postgres://postgres:postgres@localhost:5432/postgres \
TEST_ERC20_DB_URL=postgres://postgres:postgres@localhost:5432/donations_erc20_test \
FORK_URL=https://lb.routeme.sh/rpc/1/<key> \
  bun test test/processor.erc20.e2e.test.ts

# Full suite (requires Postgres + anvil + archive RPC):
TEST_DB_URL=... TEST_SUPERUSER_URL=... TEST_ERC20_DB_URL=... FORK_URL=... \
  bun test
```

## Schema

The processor creates and owns two tables on startup:

| Table | Purpose |
|---|---|
| `donation` | One row per indexed donation. PK: `${chainId}-${txHash}-native` for native, `${chainId}-${txHash}-${logIndex}` for ERC20. |
| `donations_indexer_status_v2` | Per-chain cursor: `height` + `hash` of the last committed finalized block, keyed by `chain_id`. |

Both tables are created with `IF NOT EXISTS` — safe to restart on an existing database.

## Hosting

Self-hosted on AWS Fargate. Docker builds in CI/CD only (GH Actions). No SQD Cloud — we use the Subsquid SDK but deploy ourselves.
