# That's Wrecked — Rewrite / Refactor Notes

**Date:** 2026-09-30  
**Status:** Design notes (draft)  
**Scope:** Major refactor/rewrite of the That's Wrecked platform (`thatswrecked.com`)

---

## Goals

1. **Channels on-chain** — Attacks/threats are posted to one or more channels.
2. **Low-downtime migration** — Refactor without a long outage.
3. **Cloud isolation** — That's Wrecked cloud stays **decoupled from the rest of DAMM infrastructure**, while still living in the **same AWS account**.
4. **Guardians without on-chain txs** — Guardians sign submissions off-chain; a sole relayer posts on-chain.
5. **Async duplicate + validation pipeline** — JEV duplicate check + Grok "hack clause" before on-chain post.

---

## Product: Channels

- When posting a threat/attack, the reporter chooses a **channel**.
- Contract support for channels (channel as a first-class field).
- **Open question:** allow posting to **multiple channels at once** via a **channel array** field on the submission / on-chain record.

---

## Architecture overview (target)

```
Guardian (wallet)
    │  signs payload with private key
    ▼
Public API  ──►  validate guardian whitelist + signature
    │
    ▼
SQS queue  ──►  async consumers
    │
    ├─► JEV duplicate checker (classification vs historical submissions)
    │       duplicate → drop / reject (status: duplicate)
    │       unique    → continue
    │
    └─► Grok "hack clause" checklist (prove active/real hack)
            fail → reject (status: failed validation)
            pass → Relayer posts on-chain (sole privileged poster)
```

Status endpoint lets the reporter poll submission state through the async steps.

---

## Guardians + API submission

### Keep

- **Whitelisted guardians** (same trust model as today).

### Change

- Guardians **no longer** submit transactions on-chain themselves.
- Expose an **API for submitting attacks**.
- Submission payload **must include a signature** from the guardian’s private key.
- Service validates:
  1. Signature is valid for the payload.
  2. Signer is on the **guardian whitelist**.

---

## Duplicate detection (JEV)

- After auth, check the submission is **not a duplicate** of an attack already in history.
- Use the **latest JEV model** (classification model).
- Prompt / compare: **new submission vs historical submissions**.
- Model output: duplicate or not.
- If duplicate → **discard** (do not continue to hack-clause / on-chain).

### Async note

- Duplicate check is **not** expected to run synchronously at request time.
- Pattern: enqueue to **SQS** (as today); a **JEV checker consumer** drains the queue over time.
- Separate **status endpoint** for the reporter to check progress of their reported attack.

---

## Hack clause (Grok)

- For all **valid, non-duplicate** submissions:
  - Run the existing-style **hack clause with Grok**.
  - Checklist-driven proof that the incident is an **active / real hack**.
- Only if that passes → proceed to on-chain post.

---

## On-chain posting (relayer)

- Introduce a **sole relayer**.
- Relayer is the **only** address with permission to post attacks on-chain.
- Guardians authenticate via signed API payloads; relayer is the on-chain writer.

---

## Infrastructure / ops

| Topic | Direction |
|--------|-----------|
| AWS | Same AWS account as DAMM |
| Isolation | That's Wrecked **cloud stays decoupled** from the rest of DAMM infra |
| Queue | Continue **SQS**-based async processing |
| Downtime | Explicit design goal: refactor/rewrite with **minimal downtime** (migration plan TBD) |

---

## Open questions / TBD

1. **Multi-channel posts** — channel array on-chain vs single channel + off-chain fan-out?
2. **Migration / cutover** — dual-write, feature flags, parallel stack, or freeze window?
3. **Status model** — exact states (e.g. `queued` → `jev_checking` → `duplicate` | `hack_clause` → `rejected` | `posting` → `on_chain`)?
4. **Duplicate disposition** — hard drop vs soft-flag / link to original?
5. **Guardian key UX** — how guardians produce signatures (wallet connect, CLI, existing tooling)?
6. **Relayer ops** — key custody, retries, gas, reorg / failed tx handling.
7. **JEV latency & cost** — batching, rate limits, what “historical set” is in-context vs retrieved.

---

## Suggested next steps

1. Locate current repo + map today’s guardians / SQS / Grok / on-chain flow.
2. Sketch contract changes (channels + sole relayer ACL).
3. Define submission schema + EIP-712 (or equivalent) signed typed data.
4. Define status machine + API surface (`POST /attacks`, `GET /attacks/:id`).
5. Migration plan for zero/low downtime under shared AWS account, isolated stack.

---

*Captured from product/architecture discussion with Bauti — 2026-09-30.*
