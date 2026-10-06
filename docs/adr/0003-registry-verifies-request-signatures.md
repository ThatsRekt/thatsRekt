---
status: accepted
supersedes: 0001
---

# The Registry verifies every Request signature on-chain

Only a **Relayer** writes **Posts**, **Edits**, and **Retractions**, but it can never speak for a **Guardian**. Every Relayer write — `post(Report, signature)`, `editPost(Edit, signature)`, `retract(Retraction, signature)` — carries the **Guardian**'s signed EIP-712 struct and signature. The **Registry** recomputes the digest (domain `thatsRekt`, version `2`, chain id, proxy address) and uses that digest as the **Request** id. It then requires a valid signature from the struct's `guardian` (OZ `SignatureChecker`: ECDSA or ERC-1271). When the tx executes, that `guardian` must be a **Guardian** of the **Channel** in question — the signed `channelId` for a **Report**, the **Post**'s stored **Channel** for an **Edit** or **Retraction** — and that **Channel** must be open. For an **Edit** or **Retraction**, it must also be the **Post**'s **Reporting Guardian**. The signed `deadline` must not have passed (`RequestExpired`; default 7 days after signing). The off-chain Guardian check stays only as an early filter. Design record: [`intake-redesign.md`](../intake-redesign.md) D4, D12, D30, D32, D33, D35, D55, D57, D60, D64, D65.

## Considered Options

- **Off-chain verification only; the Registry trusts the Relayer about the Reporting Guardian** (ADR 0001) — rejected. Whoever controls a **Relayer** key, or a pipeline bug, could create, **Edit**, or **Retract** **Posts** under any **Guardian**'s name. Operational mitigations (KMS, instant removal) limit how long that lasts but not what it can do.
- **ECDSA-only verification** — rejected. Governance can add any address to a **Channel**, including Safes and other contract wallets. Those wallets can only sign via ERC-1271.

## Consequences

- A **Relayer** cannot forge or alter a signed **Request**, and cannot land one after its signed `deadline`. Within the deadline it can still withhold, delay, or reorder **Requests**, and it can relay a **Guardian**-signed **Request** that the off-chain **Duplicate** or same-hack checks ruled out. That is still the **Guardian**'s own content.
- `guardian` is a signed field, so an ERC-1271 signature valid for one wallet cannot be credited to another wallet with the same owners.
- The **Request** id is the digest, never a caller argument, and is keyed by the digest rather than the signature bytes, so a malleated signature is the same **Request**.
- A **Guardian** removed from the **Channel**, or a **Channel** closed, between the off-chain check and the mined tx makes the write revert; the **Relayer service** reports **Rejected**.
- Gas per write rises by the cost of hashing the title, note, and address arrays plus one signature check.
- The typed-data schema is part of the contract ABI. Changing it is a 7-day timelocked upgrade, and the frontend, Guardian check, and **Relayer service** must share one schema definition.
- `EIP712Upgradeable` (OZ 5.6) keeps its state in an ERC-7201 namespace, so existing slots and `__gap` are untouched.
