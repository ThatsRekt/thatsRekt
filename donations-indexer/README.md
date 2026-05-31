# donations-indexer

Subsquid processor watching native-coin donations to the `thatsrekt.eth` Safe on Ethereum mainnet. Persists donation rows to a dedicated Postgres database (`thatsrekt_donations`). No Squid GraphQL server — the mesh gateway reads via a second pool.

## Stack

- **Processor:** Subsquid `@subsquid/evm-processor` with a hand-rolled `HotDatabase<void>` (no TypeORM overhead — plain pg pool, schema managed by `ensureDonationTable`)
- **Storage:** Postgres 16 (`donation` table + `donations_indexer_status` for cursor)
- **Language:** TypeScript compiled to CJS via `tsc`
- **Runtime:** Node 20

## Walking skeleton scope (slice #205)

- Ethereum mainnet + native ETH only.
- Slice #207 adds ERC20 Transfer log subscriptions.
- Slice #209 adds additional chains (Base, Arbitrum, Optimism).
- Top-level-tx value transfers only (slice #209 adds internal CALL traces).

## Quickstart — local anvil testbed

```bash
cp .env.example .env
# Edit .env if needed, then:
docker compose -f docker-compose.anvil.yml up -d
# Fund the donation Safe from the default anvil funded account:
cast send \
  --rpc-url http://127.0.0.1:18545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --value 10000000000000000 \
  0x59E4DBc95BD312A882Bb36b7f3E8298682340679
# Watch the processor index it:
docker compose -f docker-compose.anvil.yml logs -f donations-indexer
```

## Quickstart — host dev (processor + Postgres in Docker)

```bash
docker run --rm -d -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres postgres:16-alpine
bun install
bun run build
cp .env.example .env  # fill in RPC_ETHEREUM_HTTP + DONATIONS_DB_URL
bun run process
```

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RPC_ETHEREUM_HTTP` | yes | — | Ethereum RPC endpoint |
| `DONATIONS_DB_URL` | yes | — | Postgres connection string |
| `GATEWAY_URL` | no | — | Subsquid Network archive URL (omit for RPC-only) |
| `START_BLOCK_ETHEREUM` | no | `19000000` | First block to index |
| `FINALITY_CONFIRMATION` | no | `75` | Blocks before a block is treated as final |

Set `FINALITY_CONFIRMATION=0` for local anvil testing to treat all blocks as final.

## Testing

```bash
# Unit tests (no infrastructure needed):
bun test test/donationMapper.test.ts test/tokenAllowlist.test.ts

# Store e2e (real Postgres required):
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
bun test test/donationStore.e2e.test.ts

# Processor e2e (real Postgres + anvil required):
bun run build
bun test test/processor.e2e.test.ts

# Full suite:
bun test
```

## Schema

The processor creates and owns two tables on startup:

| Table | Purpose |
|---|---|
| `donation` | One row per indexed donation. PK: `${chainId}-${txHash}-native`. |
| `donations_indexer_status` | Single-row cursor: `height` + `hash` of last committed finalized block. |

Both tables are created with `IF NOT EXISTS` — safe to restart on an existing database.

## Hosting

Self-hosted on AWS Fargate. Docker builds in CI/CD only (GH Actions). No SQD Cloud — we use the Subsquid SDK but deploy ourselves.
