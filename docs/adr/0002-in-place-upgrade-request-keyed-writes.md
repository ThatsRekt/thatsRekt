---
status: accepted
---

# In-place upgrade reusing `poster`; Request-id-keyed writes replace `expectedPostId`

The relayer-based intake ships as an in-place UUPS upgrade of the existing proxy `0xBfaEEE9662b4c037De24e5Caa65815350d57b89A` on all 6 chains, via `upgradeToAndCall(newImpl, initializeV2(initialRelayer))` under the 7-day owner TimelockController. The existing `Post.poster` slot is reused to mean **Reporting Guardian**, and every **Relayer** write — `post`, each **Edit** call, `retract` — takes the **Request** id (the EIP-712 digest) as its first argument. An appended `postIdOfRequest[bytes32 → uint256]` makes each **Request** id usable once. `expectedPostId`, `peekNextPostId`, and `PostIdMismatch` are removed. Design record: [`intake-redesign.md`](../intake-redesign.md) D23, D35, D39, D41.

## Considered Options

- **Fresh Registry deployment** — rejected. It changes the address integrators read `attackerScore`/`isVictim` from, and would migrate or lose 93 **Posts** (`postCount()`: 1→59, 8453→5, 42161→7, 10→4, 56→16, 137→2), every **Vote**, and every **Guardian** set. The cost is the 7-day timelock (`getMinDelay()` = 604800 on all 6 chains), absorbed by scheduling the upgrade while the off-chain stack ships dark.
- **New `reportingGuardian` struct field** — rejected. It gives two attribution fields and a legacy fallback forever. Reusing `poster` needs no migration: on legacy **Posts** it already holds whoever reported them (mainnet: 47 by `0xFe6B…FFdb`, 12 by `0xE039…4374`, checked via `getPost` 1–59).
- **Keep `expectedPostId`** — rejected. It is a peek-then-post race that today shows up as `PostIdMismatch` retries in the relayer's classifier. Its original purpose, committing to a stable URL before mining, has no user once **Guardians** track a **Request** id and its status.
- **Just delete `expectedPostId`** — rejected. Exactly-once posting would then rest on the relayer's 24 h `PostCreated(poster = signer)` log scan (`internal/idempotency`), which breaks once `poster` comes from calldata and the sender is always the **Relayer**.

## Consequences

- `PostCreated`'s `poster` argument and the **Edit** events' `amender` carry the **Reporting Guardian**, never the **Relayer**. A new `PostRelayed(postId, relayer, requestId)` records which **Relayer** sent each write.
- Reusing a **Request** id reverts `RequestAlreadyRelayed(postId)`; the **Relayer service** treats that as **On-chain**, so SQS redeliveries and retries are idempotent on-chain. Cost: one extra SSTORE per write.
- Storage layout: existing slots unchanged, one mapping appended (taken from `__gap`). Verify with a `forge inspect` storage-layout diff before scheduling; a bug found after scheduling means cancel and reschedule (+7 days).
- `initializeV2` is a `reinitializer(2)` that installs the first **Relayer**; without it, `post()` would be **Relayer**-only with no **Relayer** for the 3-day `whitelistAdmin` add path.
- Every writer that calls `post(…, expectedPostId)` stops working at the upgrade, including today's Twitter detector relay path (D11, D40).
