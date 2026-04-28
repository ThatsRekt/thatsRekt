# Anvil bootstrap (dual-fork)

Two local Anvil forks run side-by-side as the cross-chain dev testbed:

| Slug | chainId | Forks | Host port |
|---|---|---|---|
| `anvil-eth` | 31337 | Ethereum mainnet (chainId 1) | 127.0.0.1:8545 |
| `anvil-base` | 31338 | Base mainnet (chainId 8453) | 127.0.0.1:8546 |

Distinct chain ids keep the indexer registry from conflating them with each other or with their forked-from chains.

Same dev EOA on both anvils → **identical thatsRekt CREATE2 proxy address on both** (since DeployDev's salts are constants and the EOA is the same). That means the `posts` query through Mesh sees a "real" cross-chain feed where the same contract is at the same address on multiple chains, exactly as it would be in production.

## Prerequisites

- `foundry` installed (`anvil`, `cast`, `forge`).
- Ethereum mainnet RPC (`ANVIL_ETH_FORK_URL`) and Base mainnet RPC (`ANVIL_BASE_FORK_URL`) in `indexer/.env`. Routeme.sh recommended.
- Docker + docker compose.

## Quickstart

```bash
# 1. Start both Anvil forks
cd indexer
docker compose -f docker-compose.yml -f docker-compose.anvil.yml up -d \
    anvil-eth anvil-base

# 2. Deploy thatsRekt onto each (idempotent — re-run is a no-op)
../contracts/script/anvil/bootstrap.sh anvil-eth
../contracts/script/anvil/bootstrap.sh anvil-base

# 3. Copy the printed CONTRACT_ANVIL_ETH / START_BLOCK_ANVIL_ETH and the
#    matching ANVIL_BASE values into indexer/.env

# 4. Bring up the rest of the dual-anvil stack
docker compose -f docker-compose.yml -f docker-compose.anvil.yml up -d \
    db migrate-anvil-eth processor-anvil-eth graphql-anvil-eth \
       migrate-anvil-base processor-anvil-base graphql-anvil-base \
       mesh
```

`http://localhost:4350/graphql` now serves a unified schema stitching both forks.

## Reset

```bash
contracts/script/anvil/reset.sh anvil-eth      # reset just the eth fork
contracts/script/anvil/reset.sh anvil-base     # reset just the base fork
contracts/script/anvil/reset.sh                # reset both
```

Use after schema changes or when accumulated state interferes with a fresh test run.

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `DEV_EOA` | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | Anvil default account 0 |
| `DEV_KEY` | (Anvil default account 0 key) | Public test key — **never on mainnet** |
| `ANVIL_ETH_FORK_URL` | (required in `indexer/.env`) | Ethereum mainnet RPC for the fork |
| `ANVIL_BASE_FORK_URL` | (required in `indexer/.env`) | Base mainnet RPC for the fork |
| `ANVIL_RPC` | per-chain default | Override the host endpoint for the bootstrap script |

## Output

`bootstrap.sh anvil-eth` writes `contracts/script/anvil/.deployed.anvil-eth.json` (gitignored). Same for `anvil-base`. Each contains:

```json
{
  "chain": "anvil-eth",
  "chainId": 31337,
  "blockNumber": 12345678,
  "implementation": "0x...",
  "timelock": "0x...",
  "proxy": "0x...",
  "owner": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
}
```

## Why fork mainnet (not testnet)?

- Real cross-chain story uses mainnets (Ethereum + Base + Arbitrum + …). Forking testnet doesn't exercise that.
- Mainnet state has the CREATE2 singleton factory, the Safe singleton factory, and rich on-chain history we can sanity-check against.
- No faucet ETH needed — the Anvil instance has unlimited dev ETH locally.

## Why distinct chain ids 31337 + 31338?

The indexer's chain registry treats each chainId as a unique chain. Two anvil instances with identical chainId would collide in every per-address join. 31337 (Anvil's default) + 31338 (the next free integer) — both reserved for local dev — are the right choice.
