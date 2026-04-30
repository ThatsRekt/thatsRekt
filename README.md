# thatsRekt

On-chain hack alert registry — public good.

A public list of active DeFi attacks, posted as they happen by vetted security teams. Other apps (wallets, exchanges, lending markets, bridges) read it on-chain to protect users in real time. Free to read, permissioned to post. No fees, no tokens, no profit motive.

## Live

- Site: https://thatsrekt.com
- GraphQL gateway: https://thatsrekt.com/graphql
- Integrator docs (Solidity interface, GraphQL examples, deployment addresses): https://thatsrekt.com/docs

## How posts work

- **Posters** — vetted security teams and automated detectors. They submit alerts (attacker addresses, victim contracts, a short note) and vouch (`confirm`) or refute (`disconfirm`) each other's claims.
- **Governance** — a multisig at `0x59E4DBc95BD312A882Bb36b7f3E8298682340679` (same address on every chain via CREATE2) manages the whitelist **instantly** (so a misbehaving poster can be kicked immediately) and authorizes contract upgrades. Upgrades are gated by a **7-day timelock**, so anyone using the registry has a full week to disengage if a malicious upgrade is queued.
- **Readers** — anyone. Two main signals available as cheap on-chain reads: `attackerScore(address)` (signed sum of confirmations minus disconfirmations across active posts naming the address as an attacker) and `isVictim(address)` (true if the address is the target of an active alert).

For the full integration story — Solidity interface, threshold guidance, GraphQL schema, deployment addresses — see [thatsrekt.com/docs](https://thatsrekt.com/docs).

## Repository layout

| Directory | Purpose |
|-----------|---------|
| [`contracts/`](contracts/) | Solidity smart contracts (Foundry). UUPS proxy gated by a 7-day TimelockController, deployed at the same address on every chain via CREATE2. |
| [`indexer/`](indexer/) | Per-chain TypeScript indexer. Indexes registry events into Postgres. |
| [`mesh/`](mesh/) | GraphQL stitching gateway (`@graphql-tools/stitch` + `graphql-yoga`). Single public surface; fans out to the per-chain indexers. |
| [`frontend/`](frontend/) | Static web app (Vite + React + Tailwind). Browses the registry; serves `/` and `/docs`. |
| [`relay/`](relay/) | Optional Go service for whitelisted posters running automated detectors that can't sign txs themselves. Single-tenant — operator brings their own EOA + bearer token. |
| [`ops/`](ops/) | Local-dev orchestration: Makefile + scripts to bring up the full stack on a laptop. |
| [`data/`](data/) | Reference data (e.g. historic incidents) for seeding and testing. |

## Quick start

Each component is self-contained. Pick the one you want:

- Smart contracts → [`contracts/README.md`](contracts/README.md)
- Indexer → [`indexer/README.md`](indexer/README.md)
- Gateway → [`mesh/README.md`](mesh/README.md)
- Frontend → [`frontend/README.md`](frontend/README.md)
- Relay → [`relay/README.md`](relay/README.md)
- Full local stack → [`ops/README.md`](ops/README.md)

## Integrators

Read `attackerScore` / `isVictim` directly from a contract, or query the GraphQL gateway from a dApp. Full interface, threshold tuning, GraphQL examples, and deployment addresses are at [thatsrekt.com/docs](https://thatsrekt.com/docs).

## Become a poster

The registry is only as useful as its posters. If you run a threat-intel feed, an automated detector, or an incident-response team and want to post on-chain, email **thatsrekt@protonmail.com** with who you are and what you'd be reporting.

## Governance

- **Multisig:** `0x59E4DBc95BD312A882Bb36b7f3E8298682340679` (identical on every chain via CREATE2)
- **Whitelist:** managed directly by the multisig — instant adds and removes. Posters need to be kickable the moment something goes wrong.
- **Upgrades:** gated by a 7-day TimelockController. The multisig has no direct upgrade authority — even with keys compromised, no upgrade can land in less than 7 days.
- **Whitelist admin rotation:** the timelock owner can move whitelist authority via `setWhitelistAdmin`, also gated by the 7-day delay — so a compromised whitelist admin can be revoked through the same disengage window integrators rely on for upgrades.

## License

[MIT](./LICENSE).
