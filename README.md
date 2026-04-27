# thatsRekt monorepo

Public-good on-chain hack alert registry. Whitelisted operators post structured alerts about active DeFi exploits; other whitelisters race to vouch (upvote) or refute (downvote). Other contracts (DEX routers, wallets, stablecoins) plug in and inline-blacklist live attacker addresses.

## Layout

| Directory | Purpose |
|-----------|---------|
| [`contracts/`](contracts/) | Solidity smart contracts (Foundry). UUPS upgradeable proxy with TimelockController. |
| [`indexer/`](indexer/) | Subsquid indexer (TypeScript). Indexes contract events, exposes GraphQL API. (Coming soon.) |
| `frontend/` | IPFS-hosted static site at `thatsrekt.eth`. (Coming later.) |

## Quick start

- Smart contracts: see [contracts/README.md](contracts/README.md).
- Indexer: see [indexer/README.md](indexer/README.md). _(Pending Phase 1 implementation.)_

## Project status

Pre-deployment. Contract design complete (see [contracts/tasks/](contracts/tasks/)). Indexer plan in [indexer/tasks/](indexer/tasks/). Frontend not yet started.
