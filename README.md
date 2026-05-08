# thatsRekt

On-chain hack alert registry — public good.

A public list of active on-chain exploits across every EVM chain, posted as they happen by vetted security teams. Other apps (wallets, exchanges, lending markets, bridges) read it on-chain to protect users in real time. Free to read, permissioned to post. No fees, no tokens, no profit motive.

## Live

- Site: https://thatsrekt.com
- GraphQL gateway: https://thatsrekt.com/graphql
- Integrator docs (Solidity interface, GraphQL examples, deployment addresses): https://thatsrekt.com/docs

### Deployments (v1.2.0, 2026-05-07)

Canonical proxy address — identical on every chain via CREATE2:

```
0xBfaEEE9662b4c037De24e5Caa65815350d57b89A
```

| Chain | ChainId | Explorer |
|---|---|---|
| Ethereum | 1 | [etherscan](https://etherscan.io/address/0xBfaEEE9662b4c037De24e5Caa65815350d57b89A) |
| Base | 8453 | [basescan](https://basescan.org/address/0xBfaEEE9662b4c037De24e5Caa65815350d57b89A) |
| Arbitrum One | 42161 | [arbiscan](https://arbiscan.io/address/0xBfaEEE9662b4c037De24e5Caa65815350d57b89A) |
| Optimism | 10 | [optimistic.etherscan](https://optimistic.etherscan.io/address/0xBfaEEE9662b4c037De24e5Caa65815350d57b89A) |

## How posts work

- **Posters** — vetted security teams and automated detectors. They submit alerts (attacker addresses, victim contracts, a short note) and vouch (`confirm`) or refute (`disconfirm`) each other's claims.
- **Governance** — a multisig at `0x59E4DBc95BD312A882Bb36b7f3E8298682340679` (same address on every chain via CREATE2). It can **remove a misbehaving poster instantly** (incident response), but **adding a new poster takes 3 days** through a dedicated timelock so the rotation is publicly visible before it lands. Contract upgrades are gated by a separate **7-day timelock**, so anyone using the registry has a full week to disengage if a malicious upgrade is queued.
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

Three roles with asymmetric delays — adding posters is slow and public, kicking them out is instant.

- **Multisig:** `0x59E4DBc95BD312A882Bb36b7f3E8298682340679` (identical on every chain via CREATE2). Proposes on every timelock; holds the kill-switch directly.
- **Adding posters:** gated by a **3-day TimelockController** (the `whitelistAdmin` slot). The multisig schedules `addWhitelisted(addr)`, waits 3 days, then executes. Long enough for integrators to react if the multisig schedules a hostile operator; short enough that real-world onboarding doesn't grind.
- **Removing posters:** **instant.** The multisig holds the `whitelistRemover` slot directly and calls `removeWhitelisted(addr)` immediately when an incident demands it.
- **Kill-switch:** the multisig can also call `revokeWhitelistAdmin()` instantly — this zeros the `whitelistAdmin` slot, blocking all new additions until the upgrade timelock owner re-installs an admin via the 7-day path. Buys breathing room if the add timelock itself is captured.
- **Upgrades:** gated by a separate **7-day TimelockController** (the `owner` slot). The multisig has no direct upgrade authority — even with keys compromised, no upgrade can land in less than 7 days.
- **Initial poster set:** to avoid waiting 3 days for the registry's first posters, the launch deploy script pre-populates the whitelist via `INITIAL_WHITELISTERS`. This is the only legitimate bypass of the add timelock and only happens once at `initialize`.

## License

[MIT](./LICENSE).
