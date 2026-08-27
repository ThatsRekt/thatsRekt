# thatsRekt Context

thatsRekt is a cross-chain public registry and donations surface whose read models are derived from chain history. This glossary defines the project-specific language shared by its registry and donations domains.

## Language

**Registry Indexer**:
The indexing family that represents registry activity as the registry read model.
_Avoid_: squid, processor

**Donations Indexer**:
The indexing family that represents donations to the thatsRekt donation recipient as the donations read model.
_Avoid_: donation squid, donation processor

**Indexer Family**:
Either the Registry Indexer or Donations Indexer, each owning its own representation of chain-derived data.
_Avoid_: shared indexer

**Production Chain**:
One of Ethereum, Base, Arbitrum One, Optimism, BNB Chain, or Polygon in the Portal migration.
_Avoid_: chain when a testnet or Local Anvil Fork might be meant

**Local Anvil Fork**:
A local chain used to exercise thatsRekt behavior against forked chain state.
_Avoid_: Production Chain

**Legacy Archive Gateway**:
The pre-Portal historical event source used by existing indexers.
_Avoid_: Portal Dataset Endpoint

**Portal Dataset Endpoint**:
The SQD Portal dataset location selected for an Indexer Family and Production Chain.
_Avoid_: gateway

**Portal Authentication**:
The optional authorization associated with access to a Portal Dataset Endpoint.
_Avoid_: Portal Dataset Endpoint

**Portal Head**:
The highest block currently available from a Portal Dataset Endpoint.
_Avoid_: chain head

**Indexer Cursor**:
The durable position identifying the chain history represented by one Indexer Family for one chain.
_Avoid_: generic cursor

**Freshness**:
The currency of an Indexer Cursor relative to the Portal Head.
_Avoid_: no-progress

**No-progress**:
The family-specific condition in which expected cursor advancement has stopped despite advancing source history.
_Avoid_: freshness

## Relationships

- An **Indexer Family** represents chain history for one or more **Production Chains**.
- One **Production Chain** has one **Portal Dataset Endpoint** per **Indexer Family** after migration.
- A **Portal Dataset Endpoint** MAY have **Portal Authentication**.
- Each Indexer Family/Production Chain pair has one **Indexer Cursor**.
- A **Local Anvil Fork** is not a **Production Chain**.

## Example dialogue

> **Dev:** "Does Base use the same **Portal Dataset Endpoint** for the **Registry Indexer** and **Donations Indexer**?"
> **Domain expert:** "They are separate Indexer Families, so each has its own selected endpoint and cursor; either endpoint may have optional Portal Authentication."

## Flagged ambiguities

- `gateway` previously described both the current historical source and the intended replacement — resolved: it means only **Legacy Archive Gateway**; use **Portal Dataset Endpoint** for Portal.
- `chain` previously mixed production, testnet, and local environments — resolved: use **Production Chain** or **Local Anvil Fork** where that distinction matters.
- `freshness` previously risked being used as a synonym for stalled processing — resolved: **Freshness** and **No-progress** are distinct signals.
