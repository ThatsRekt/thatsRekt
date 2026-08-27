# donations-indexer

Indexes direct native-coin and allowlisted ERC20 donations to the current
`thatsrekt.eth` recipient across Ethereum, Base, Arbitrum One, Optimism, BNB
Chain, and Polygon. Donation rows are stored in `thatsrekt_donations`; Mesh
reads that table directly.

## Historical ingestion contract

- Every Production Chain reads historical blocks only from its configured
  Portal Dataset Endpoint:
  `ethereum-mainnet`, `base-mainnet`, `arbitrum-one`, `optimism-mainnet`,
  `binance-mainnet`, or `polygon-mainnet`.
- `PORTAL_URL` is a generic dataset-base URL. The runtime appends the
  chain-selected dataset; `PORTAL_API_KEY` is optional and, when present, is
  sent only as `x-api-key`.
- Chain RPC and ENS RPC are control-plane reads only: they bound the finalized
  range and resolve the donee. They are never historical fallbacks.
- The processor uses finalized Portal batches and an inclusive bounded range,
  then exits. The container enforces a 25-minute outer deadline.

## Configuration

`CHAIN_SLUG`, `PORTAL_URL`, `DONATIONS_DB_URL`, and the selected chain's RPC
head variable are required. See `.env.example` for a non-secret configuration
template.

| `CHAIN_SLUG` | Portal dataset | RPC head variable | Start-block override |
|---|---|---|---|
| `ethereum` | `ethereum-mainnet` | `RPC_ETHEREUM_HTTP` | `START_BLOCK_ETHEREUM` |
| `base` | `base-mainnet` | `RPC_BASE_HTTP` | `START_BLOCK_BASE` |
| `arbitrum` | `arbitrum-one` | `RPC_ARBITRUM_HTTP` | `START_BLOCK_ARBITRUM` |
| `optimism` | `optimism-mainnet` | `RPC_OPTIMISM_HTTP` | `START_BLOCK_OPTIMISM` |
| `bsc` | `binance-mainnet` | `RPC_BSC_HTTP` | `START_BLOCK_BSC` |
| `polygon` | `polygon-mainnet` | `RPC_POLYGON_HTTP` | `START_BLOCK_POLYGON` |

## Persistence and restart safety

`donation` is idempotent by deterministic primary key. Every finalized Portal
batch maps rows and updates its `donations_indexer_status_v2` cursor in the
same PostgreSQL transaction. The cursor update is conditional and cannot move
backward:

```sql
UPDATE donations_indexer_status_v2 SET height=$1, hash=$2
WHERE chain_id=$3
  AND (height < $1 OR (height = $1 AND hash = $2))
```

A higher stored cursor is a benign delayed replay; equal height/hash is
idempotent. Missing state, a hash conflict at equal height, or an impossible
post-update regression fails the transaction and preserves resumable state.

## Targeted verification

The deterministic harness uses captured fixtures and a local Postgres instance;
it does not call production endpoints or require credentials.

```bash
bun test test/portal.test.ts test/blockRange.test.ts \
  test/processor.portal.test.ts test/cursor.e2e.test.ts \
  test/portalIntegrity.e2e.test.ts
bun run build
```

## Runtime

The container runtime is Node 22. Docker images are built in CI/CD only; this
repository does not deploy from the local developer workflow.

The scheduled task runs at `rate(30 minutes)`, leaving a five-minute margin
after the 25-minute container deadline before the next invocation.
