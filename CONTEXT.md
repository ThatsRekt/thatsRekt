# thatsRekt Context

thatsRekt is a cross-chain public registry of hacks and a donations surface whose read models are derived from chain history. Trusted **Guardians** report hacks, and integrators read attacker and victim status straight from each chain's **Registry**. This glossary defines the project-specific language shared by its registry, intake, and donations domains.

## Language

### Roles

**Guardian**:
A whitelisted person trusted to report and vouch for hacks.
_Avoid_: Reporter, poster, whitelisted address

**Relayer**:
The on-chain role that alone can create, **Edit**, and **Retract** **Posts**, always on behalf of a **Guardian**; the contract allows more than one, and no address is both a **Relayer** and a **Guardian**.
_Avoid_: Poster, publisher, bot

**Relayer service**:
The DAMM-run cloud service that holds a **Relayer** key.
_Avoid_: Relayer (when meaning the service), signer

### Records

**Registry**:
The thatsRekt contract on one chain, fully isolated and unaware of the **Registries** on other chains.
_Avoid_: Proxy, deployment, "the contract" (when a specific chain matters)

**Report**:
A submission about a hack on exactly one chain that has not been posted on-chain yet.
_Avoid_: Submission, post, alert

**Post**:
The on-chain record of a hack in one **Registry**.
_Avoid_: Report, incident, attack

**Reporting Guardian**:
The **Guardian** whose **Report** a **Post** was made from.
_Avoid_: Poster, author, submitter

**Duplicate**:
A **Report** about a hack that an older live **Post**, or an older **Report** still in progress, already covers on the same chain.
_Avoid_: Repost, copy, dupe

**Incident**:
One hack as a whole, grouping the **Posts** about it across chains; known only off-chain.
_Avoid_: Group, cluster, multi-chain post

### Changes to Posts

**Edit**:
A **Guardian**'s signed change to an existing **Post**, naming its chain and **Post** id.
_Avoid_: Amendment, update, patch

**Retraction**:
A **Reporting Guardian** taking back their own **Post**, carried out by a **Relayer**; the **Post** stays on record as retracted.
_Avoid_: Delete, removal, purge

**Purge**:
Governance removing an abusive or illegal **Post** so every feed hides it; never done by a **Relayer**.
_Avoid_: Delete, retraction, takedown

### Requests

**Request**:
A signed **Report**, **Edit**, or **Retraction** sent to the API, tracked by its own Request id.
_Avoid_: Job, message, ticket

**Request signature**:
A **Guardian**'s EIP-712 typed-data signature over a **Request**'s complete contents, proving that **Guardian** made and approves every field; checked off-chain only and never sent to the contract.
_Avoid_: Report signature, auth, proof, token

**Rejected**:
The outcome of a **Request** whose signature is invalid, whose signer may not make it, whose signed contents have expired or been overtaken by a newer change to the **Post**, that Jev could not check, or (for an **Edit**) that would make the **Post** describe a different hack.
_Avoid_: Denied, unauthorized

**On-chain**:
The outcome of a **Request** whose **Relayer** transaction was mined.
_Avoid_: Done, posted, confirmed

**Failed**:
The outcome of a **Request** that could not be checked or put on-chain because of an error on DAMM's side, not the **Guardian**'s.
_Avoid_: Rejected, error

### Consensus

**Vote**:
A **Guardian**'s **Upvote** or **Downvote** on one **Post**, sent from the **Guardian**'s own wallet.
_Avoid_: Confirmation, disconfirmation, endorsement

**Upvote**:
A **Vote** saying the **Post** is accurate.
_Avoid_: Confirm, like

**Downvote**:
A **Vote** saying the **Post** is wrong.
_Avoid_: Disconfirm, dispute, flag

### Indexing

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

### Intake and posting

- Only a **Post**'s **Reporting Guardian**, while still a **Guardian** on that chain, may request an **Edit** or **Retraction** of it; once removed, their **Posts** can only be **Purged**
- Every **Request** must carry a valid **Request signature** from a **Guardian** of its chain, or it is **Rejected** before any other check
- Everything a **Relayer** writes for a **Request** comes from its signed contents, except the new **Post**'s id and the **Reporting Guardian** (the signer); nothing in the pipeline adds or changes a signed field
- Every **Request** ends in exactly one outcome: **Rejected**, **Duplicate**, **On-chain**, or **Failed**
- Whether a **Report** is accepted is decided entirely by the off-chain pipeline; the **Registry** trusts the **Relayer**'s word on who the **Reporting Guardian** is and does not re-check it
- Each **Registry** has its own **Guardian** set; being a **Guardian** on one chain says nothing about another
- Within a **Registry**, an address is either a **Guardian** or a **Relayer**, never both at once
- A **Relayer service** holds one **Relayer** key
- A hack that hits several chains is reported as one **Report** per chain
- A **Report** becomes at most one **Post**, on the chain it names
- A **Report** is only checked for being a **Duplicate** against its own chain: live **Posts** and older **Reports** still in progress; retracted or purged **Posts** never make a **Report** a **Duplicate**
- Of two **Reports** about the same hack, only the newer can be the **Duplicate**
- A **Duplicate** points to the **Post** or **Report** it repeats; it never changes that **Post**
- A **Post** is written by a **Relayer** and names exactly one **Reporting Guardian**
- A **Post** and every **Edit** to it are attributed on-chain to its **Reporting Guardian**, never to the **Relayer** that sent them; the sending **Relayer** is recorded separately
- A **Request** is carried out on-chain at most once
- An **Incident** groups **Posts** across chains but never makes a **Report** a **Duplicate**; **Duplicates** are judged per chain only
- Accepting a **Report** means it was signed by a **Guardian** and is not a **Duplicate**, not that it is true; whether a **Post** is true is signalled by **Guardians**' **Votes**
- An **Edit** is never checked for being a **Duplicate**, but is always checked to still describe the same hack before a **Relayer** applies it
- A **Retraction** is never checked beyond the **Guardian**'s signature
- A **Post** can be both retracted and purged; the two are recorded separately

### Consensus

- A **Guardian** casts at most one **Vote** per **Post**, and never on a **Post** they are the **Reporting Guardian** of
- **Votes** never go through a **Relayer**

### Indexing

- An **Indexer Family** represents chain history for one or more **Production Chains**.
- One **Production Chain** has one **Portal Dataset Endpoint** per **Indexer Family** after migration.
- A **Portal Dataset Endpoint** MAY have **Portal Authentication**.
- Each Indexer Family/Production Chain pair has one **Indexer Cursor**.
- A **Local Anvil Fork** is not a **Production Chain**.

## Example dialogue

> **Dev:** "Can a **Guardian** remove their **Post** directly on-chain?"
> **Domain expert:** "No — they send a **Retraction** and a **Relayer** carries it out. If the **Post** is abusive, that's a **Purge**, and only governance can do it."

> **Dev:** "Does Base use the same **Portal Dataset Endpoint** for the **Registry Indexer** and **Donations Indexer**?"
> **Domain expert:** "They are separate Indexer Families, so each has its own selected endpoint and cursor; either endpoint may have optional Portal Authentication."

## Flagged ambiguities

- "poster" meant the tx sender, the role that writes posts, and the person behind the hack report — resolved: the role is **Relayer**, the person is the **Reporting Guardian**; "poster" is retired.
- "relayer" meant both the on-chain role and the cloud service — resolved: **Relayer** is the role, **Relayer service** is what DAMM runs.
- "confirm" meant both a **Vote** and a mined transaction — resolved: say **Upvote**/**Downvote**; "confirm" is reserved for transactions.
- "delete" was used for both a **Guardian** taking back their **Post** and governance moderation (the contract's `purgePost`) — resolved: **Retraction** vs **Purge**; "delete" is retired.
- "Report signature" stopped fitting once **Edits** and **Retractions** were signed too — resolved: **Request signature** covers all three.
- `gateway` previously described both the current historical source and the intended replacement — resolved: it means only **Legacy Archive Gateway**; use **Portal Dataset Endpoint** for Portal.
- `chain` previously mixed production, testnet, and local environments — resolved: use **Production Chain** or **Local Anvil Fork** where that distinction matters.
- `freshness` previously risked being used as a synonym for stalled processing — resolved: **Freshness** and **No-progress** are distinct signals.
