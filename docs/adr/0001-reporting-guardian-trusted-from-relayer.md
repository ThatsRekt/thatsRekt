---
status: accepted
---

# The Registry trusts the Relayer about the Reporting Guardian

From the intake redesign on, only a **Relayer** writes **Posts**, **Edits**, and **Retractions** on-chain, acting for the **Guardian** who signed the **Request** (the **Reporting Guardian**). The **Request signature** (EIP-712 over the full payload) is checked only off-chain, by the Guardian check that consumes the `intake` queue; it is never sent to the contract. `post(requestId, reportingGuardian, …)` stores `reportingGuardian` as given — the **Registry** does not recover a signer and does not re-check that the address is a **Guardian**. Whether a **Report** is accepted is decided entirely by the off-chain pipeline (Guardian check → Jev **Duplicate** check). Design record: [`intake-redesign.md`](../intake-redesign.md) D4, D12, D30, D46.

## Considered Options

- **Contract re-verifies the EIP-712 signature** — rejected. Every signed field (title, note, attackers, victims, `attackedAt`, optional `txHashes`, `deadline`) would have to go on-chain as calldata and be hashed in the contract, raising gas on every write and coupling the on-chain ABI to the off-chain typed-data schema, so any schema change becomes a 7-day timelocked upgrade. It would also not stop a malicious **Relayer**: it chooses which signed **Requests** to relay and when.
- **`isGuardian[reportingGuardian]` check in `post()`** — rejected. Membership is already checked off-chain against the same on-chain **Guardian** set. Re-checking only adds a revert path for a **Guardian** removed between the Guardian check and the mined tx, where the off-chain decision has already been made.

## Consequences

- Accepted risk: whoever controls a **Relayer** key (or a pipeline bug) can create, **Edit**, or **Retract** **Posts** under any **Guardian**'s name. Mitigations are operational, not cryptographic: the **Relayer** key lives in KMS; adding a **Relayer** goes through governance (3-day `whitelistAdmin` timelock, the first one through the 7-day upgrade), removal is instant via `whitelistRemover`; a **Relayer** can never **Purge** (D17, D21, D37).
- Off-chain attribution is auditable: every **Relayer** write emits `PostRelayed(postId, relayer, requestId)`, and `requestId` is the EIP-712 digest of the public signed **Request** (D31, D35), so anyone can recover the signer and compare it with the stored **Reporting Guardian**.
- A **Guardian** removed after passing the Guardian check still gets the **Post**.
- Do not "fix" this by adding signature verification to the contract without revisiting the rejected option above.
