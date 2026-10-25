---
status: accepted
---

# Guardians may Vote from their wallet or as a signed Vote a Relayer sends

A **Guardian** can **Upvote**, **Downvote**, or clear a **Vote** either from their own wallet (`confirm`/`unconfirm`, as today) or by signing an EIP-712 **Vote** (`guardian, postId, direction, expectedCurrentVote, deadline`) that a **Relayer** sends through `vote(Vote, signature)`. The **Registry** runs the same checks as every other **Relayer** write (ADR 0003): signature, membership of the **Post**'s open **Channel**, deadline, **Request** id used once. It also keeps the self-vote rule, and reverts `StaleVote` unless the voter's current **Vote** on the **Post** equals `expectedCurrentVote`, so a delayed relayed **Vote** never overwrites a later wallet **Vote**. The signature machinery exists anyway, so relaying finishes "**Guardians** without on-chain txs", lets bot **Guardians** corroborate without holding gas on 6 chains, and gives a **Duplicate**'s "**Upvote** the original" a gasless path. Design record: [`intake-redesign.md`](../intake-redesign.md) D6, D7, D35, D55, D63, D65, D79, D88.

## Considered Options

- **Wallet-only Votes** (the first answer) — rejected in review. Every **Guardian**, including bots, would need gas on every chain to corroborate, and "**Upvote** the original" after a **Duplicate** would cost the **Guardian** a tx.
- **Relayed-only Votes** — rejected. It breaks today's wallet **Guardians** and integrators that send `confirm` directly.
- **No stale check** — rejected. A relayed **Vote** waiting in the relay FIFO could land after the **Guardian** changed their **Vote** from the wallet and silently revert it (the same risk `expectedLastUpdatedAt` closes for **Edits**).

## Consequences

- The ABI gains `vote(Vote, signature)`, the **Vote** typed-data struct, and `StaleVote`, so this is fixed before the upgrade is scheduled.
- DAMM pays gas for relayed **Votes**. They get their own per-(**Guardian**, chain) quota (100 per 24 h), separate from **Reports** and **Edits**, so voting during a busy incident never uses up a **Guardian**'s reporting allowance.
- A relayed **Vote** skips the comparison service, like a **Retraction**.
- A relayed **Vote**'s events name the signing **Guardian**; `PostRelayed` records the **Relayer** that sent it.
