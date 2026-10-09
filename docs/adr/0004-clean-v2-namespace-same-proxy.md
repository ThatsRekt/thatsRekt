---
status: accepted
supersedes: 0002 (storage approach only; its Request-id-keyed writes stand)
---

# Same proxy, clean v2 storage; only the scores carry over; the API stitches legacy Posts

v2 ships as a new implementation behind the existing proxy `0xBfaEEE9662b4c037De24e5Caa65815350d57b89A` on all 6 chains, but it keeps nothing from v1 except the scores. All v2 state (**Channels**, **Posts**, **Votes**, roles, the **Relayer** set, `postIdOfRequest`, the post feed) lives in one ERC-7201 namespace. The only v1 storage it touches is the four score mappings, declared at their existing slots and kept live: `attackerScore` (10), `attackerAppearances` (11), `isVictim` (12), `_victimActivePosts` (13). Every other v1 slot is never read or written again. Legacy **Posts** are frozen on-chain history, and the API (Mesh) stitches them with v2 **Posts** into one feed, presenting them as `main`. Priorities, in order: keep the **Registry** address; carry no tech debt from v1 (v2 is not backwards compatible); let the API stitch old and new. Design record: [`intake-redesign.md`](../intake-redesign.md) D23, D61, D70, D71, D72, D73, D77.

## Considered Options

- **Carry the v1 layout forward and append** (ADR 0002) — rejected. The v1 `Post` struct, the dead `isWhitelisted` mapping, `__gap` arithmetic, and a loop tagging the 93 legacy **Posts** as `main` would stay in the contract forever.
- **Fresh Registry deployment** — rejected. It changes the address integrators read `attackerScore`/`isVictim` from.
- **Clean slate that also resets the scores** — rejected. On-chain readers of `attackerScore`/`isVictim` would lose the history of the 93 legacy **Posts**.
- **Copy the scores into the new namespace from `initializeV2` calldata** — rejected. The values are already live in the proxy, and a snapshot taken when the upgrade is scheduled goes stale: legacy **Posts** can still be voted on during the 7-day delay.

## Consequences

- The owner (7-day TimelockController) and the initializer version carry over untouched: OZ 5.6 keeps `Ownable`, `Ownable2Step`, and `Initializable` state in their own namespaces.
- Legacy **Posts** take no more **Votes**, **Edits**, **Retractions**, or **Purges**, and no v2 getter returns them. Their score contributions stay fixed, and `_victimActivePosts` is only ever changed again by v2 **Posts**, so `isVictim` stays consistent.
- Every consumer of the **Registry** ABI and events (indexer, Mesh, frontend, notifier, **Relayer service**, outside integrators) moves to the v2 ABI at the upgrade. The indexer keeps the v1 handlers beside the v2 ones and reads both formats from the proxy into one model, so a re-index from block 0 rebuilds legacy and v2 data alike; every API object carries a `schemaVersion` (`1` legacy, `2` v2) (D77).
- The four score mappings are pinned at fixed slots: documented in code and held by a Foundry storage-layout test.
- `initializeV2` reads the v1 `postCount` (slot 5) once, at execution, so v2 **Post** ids continue each chain's numbering and never collide with legacy ids (D72). No runtime code reads v1 **Post** storage.
- A legacy **Post**'s contributions to the live scores can never be undone through v2: a wrongly flagged attacker or victim stays flagged for on-chain readers. So executing the upgrade is gated on a final audit of the legacy **Posts**, with any bad one purged through v1's `purgePost` (1-day purge timelock) before execution (D73). v2 has no legacy correction path.
