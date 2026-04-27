# thatsRekt Subsquid Indexer — Implementation Plan

**Date:** 2026-04-27
**Status:** DRAFT — pending operator sign-off on open questions
**Owner:** bauti
**Predecessor:** Idea 4 from `DAMMfi-knowledge-base/conversations/bauti/2026-04-27_thatsrekt-v1-ideas.md`

## 1. Goal

Build a self-hosted Subsquid indexer that indexes thatsRekt contract events and exposes them via GraphQL. Lets the future frontend (and any other consumer) query the registry without RPC roundtrips.

## 2. Stack and Hosting

| Component | Choice |
|-----------|--------|
| **Indexer framework** | Subsquid (Squid SDK) |
| **Handler language** | TypeScript |
| **Storage** | Postgres |
| **Query API** | GraphQL (auto-generated from `schema.graphql`) |
| **Data source** | SQD Network (free at our volume) |
| **Hosting (initial)** | Self-host — VPS / docker-compose |
| **Hosting (later, optional)** | SQD Cloud paid tier when growth warrants |

## 3. Repo Structure — Monorepo Refactor

Existing structure has contracts at root. Restructure to:

```
thatsRekt/
├── README.md                 (top-level — describes the monorepo)
├── .gitignore                (top-level)
├── contracts/                (existing root contents move here)
│   ├── README.md
│   ├── foundry.toml
│   ├── lib/
│   ├── script/
│   ├── src/
│   ├── tasks/
│   └── test/
├── indexer/                  (NEW — squid project)
│   ├── README.md
│   ├── package.json
│   ├── tsconfig.json
│   ├── schema.graphql
│   ├── squid.yaml
│   ├── docker-compose.yml
│   ├── src/
│   ├── abis/
│   └── ...
└── frontend/                 (LATER — out of scope here)
```

**Migration approach:**
- Use `git mv` to preserve history.
- All contract files move into `contracts/` as a single "monorepo restructure" commit.
- A NEW top-level `README.md` describes the monorepo layout, points to per-package READMEs.
- The contract `README.md` stays in `contracts/README.md` unchanged.

**CI considerations:** No CI exists yet. When adding it later, configure paths-aware checks (`forge test` runs only on `contracts/**` changes; `pnpm test` runs only on `indexer/**` changes).

## 4. Phases

### Phase 0 — Monorepo restructure (single PR, separate from indexer work)

1. Create `contracts/` directory.
2. `git mv` all current root files (except `.git*`, plan files in `tasks/`) into `contracts/`. The `tasks/` directory ALSO moves into `contracts/tasks/` since those plans (v0, upgradeable, and this one) are contract-relevant. Actually — **this plan stays at root in `tasks/` initially, then moves with the others as part of phase 0**. Or it can move into `indexer/tasks/` since it's indexer-relevant. **Decision:** keep all task plan files in the workstream they pertain to: contract-related plans → `contracts/tasks/`, indexer plans → `indexer/tasks/`. So this plan moves to `indexer/tasks/squid-indexer-plan.md` once `indexer/` exists.
3. Create top-level `README.md`:
   ```markdown
   # thatsRekt monorepo

   - `contracts/` — Solidity smart contracts (Foundry). See [contracts/README.md](contracts/README.md).
   - `indexer/`   — Subsquid indexer (TypeScript). See [indexer/README.md](indexer/README.md).
   - `frontend/`  — coming later.
   ```
4. Update `.gitignore` if any paths were absolute.
5. Verify: `cd contracts && forge test` still passes.
6. Single commit: `chore: restructure into monorepo (contracts/ + indexer/ placeholder)`.

### Phase 1 — Squid scaffold

1. `cd indexer && npx sqd init thatsrekt-indexer -t evm -d .` (or pnpm equivalent — confirm on Subsquid docs latest).
2. Configure `squid.yaml` for the chain we're targeting (open question — initial chain).
3. Configure `docker-compose.yml` for local Postgres.
4. `pnpm install`, `pnpm build`, `pnpm sqd up` (starts Postgres), `pnpm sqd run` (starts indexer locally).
5. Verify: `pnpm sqd serve` (starts GraphQL server), navigate to `http://localhost:4350/graphql`, see empty schema — proof of life.

### Phase 2 — Schema design (`schema.graphql`)

Entities to model (full schema in §6 below):

- **`Post`** — core entity. Fields: id, poster, attackedAt, lastUpdatedAt, attackers, victims, note, upvotes, downvotes, removed, createdAtBlock, createdAtTimestamp.
- **`Vote`** — historical record of every vote action. Fields: id (postId-voter-blockNumber), post, voter, direction, blockNumber, timestamp.
- **`Address`** — derived aggregate. Fields: id (the address), attackerScore, attackerAppearances, isVictim, postsAsAttacker[Post[]], postsAsVictim[Post[]], votesAsVoter[Vote[]].
- **`WhitelistChange`** — historical. Fields: id, addr, added (bool), blockNumber, timestamp.
- **`Edit`** — historical record of amendNote / addAttackers / addVictims. Fields: id, post, kind (enum), payload, blockNumber, timestamp.
- **`Removal`** — historical. Fields: id, post, blockNumber, timestamp.
- **`Upgrade`** — historical record of proxy upgrades. Fields: id, oldImpl, newImpl, scheduler, executor, blockNumber, timestamp.

### Phase 3 — Event handlers

Map every contract event to entity mutations:

| Contract event | Handler does |
|----------------|--------------|
| `PostCreated` | Create `Post` entity. Create / update `Address` for each attacker (increment `attackerAppearances`, score unchanged at creation since votes start at 0). Create / update `Address` for each victim (set `isVictim = true`). |
| `Voted` (newDir != None) | Create `Vote` entity. Update `Post.upvotes` / `Post.downvotes`. Update `attackerScore` for each attacker in the post (delta = `weight(newDir) - weight(oldDir)`). |
| `Voted` (newDir == None, i.e. unvote) | Same handler with delta math. Vote entity recorded with `direction = None`. |
| `Retracted` | Set `Post.removed = true`. Decrement `Address.isVictim` count for each victim (or recompute `isVictim = exists(other live post with this victim)`). Reverse aggregates. |
| `WhitelistUpdated` | Create `WhitelistChange` entity. (No aggregate change — whitelist is on-chain authority, not user-facing reputation.) |
| `PostNoteAmended` | Create `Edit` entity (kind=Note). Update `Post.lastUpdatedAt`. (Note text is in the event, not stored in indexer either — but emit it in the Edit entity for completeness.) |
| `AttackersAdded` | Create `Edit` entity (kind=AddAttackers). Append to `Post.attackers`. For each new attacker: create / update `Address`, set `attackerScore += postCurrentNet`, increment `attackerAppearances`. Update `Post.lastUpdatedAt`. |
| `VictimsAdded` | Create `Edit` entity (kind=AddVictims). Append to `Post.victims`. For each new victim: set `isVictim = true`. Update `Post.lastUpdatedAt`. |
| `Upgraded` (from UUPSUpgradeable) | Create `Upgrade` entity. (No aggregate change.) |

**Block reorg handling:** Subsquid's standard rollback support handles this.

### Phase 4 — Tests

Subsquid has a test framework but it's lighter than Foundry's. Approach:
- Unit tests for handler functions (using mocked block context + event data).
- Integration test: run against a known testnet deployment (once contract is deployed).
- Snapshot testing for GraphQL queries — given a known chain state, query results are deterministic.

### Phase 5 — Local dev experience

- `indexer/README.md` documents:
  - Prereqs (Node, pnpm, Docker).
  - `pnpm sqd up` to start Postgres.
  - `pnpm sqd run` to start indexer.
  - `pnpm sqd serve` to start GraphQL.
  - Sample queries.
- Add to top-level monorepo README a quick-start section.

### Phase 6 — Multi-chain config (DEFERRED)

When the contract deploys to multiple chains, configure the indexer to handle each:
- Option A: one squid per chain (simpler, separate Postgres per chain).
- Option B: multichain squid (single indexer, single Postgres, chain-aware entities).

**Decision deferred until first cross-chain deploy.** v1 indexer targets a single chain.

### Phase 7 — Production deployment (DEFERRED)

Once contract has live deployments:
- Pick a VPS / cloud provider for hosting (DigitalOcean droplet, Hetzner, AWS).
- Deploy via docker-compose: indexer + Postgres + GraphQL server.
- Reverse proxy (Caddy / Traefik) for TLS at `api.thatsrekt.eth` (or wherever).
- Backup strategy for Postgres.

## 5. Open Questions for Operator

1. **Initial target chain.** The contract isn't deployed anywhere yet. For testing the indexer, we need *some* chain. Options:
   - **Sepolia** — pure testnet, free, slow (12s blocks). Fine for handler dev.
   - **Base Sepolia** — free, faster, common testnet for L2-flavored testing.
   - **Wait until first mainnet deploy** — build indexer infrastructure first, deploy against mainnet directly.

   **My lean:** Sepolia for handler dev, then mainnet (whichever chain ships first) for production index.

2. **Hosting target.**
   - VPS at start? (DigitalOcean / Hetzner / similar.)
   - Run on Bauti's local machine for dev?
   - Future cloud (AWS / GCP / etc.)?

   **My lean:** local Docker for dev. Hetzner / DigitalOcean droplet (~$10/mo) for production initially. Migrate to whatever scales when needed.

3. **GraphQL endpoint domain.**
   - `api.thatsrekt.eth` (matches the ENS domain we already have for the future frontend)?
   - Or a separate domain?
   - Or just IP / no domain initially?

   **My lean:** `api.thatsrekt.eth` once the IPFS site is up. Plain IP / .com initially.

4. **Multi-chain config from day 1 or single-chain?**
   - **My lean:** single-chain initially. Multi-chain config deferred until needed.

## 6. Schema sketch

```graphql
# A whitelisted address that posts hack alerts or votes on them.
type Whitelister @entity {
  id: ID!  # the address
  isCurrentlyWhitelisted: Boolean!
  whitelistedAt: DateTime
  removedAt: DateTime
  posts: [Post!]! @derivedFrom(field: "poster")
  votes: [Vote!]! @derivedFrom(field: "voter")
  changes: [WhitelistChange!]! @derivedFrom(field: "addr")
}

# A hack alert post.
type Post @entity {
  id: ID!  # postId from the contract
  poster: Whitelister!
  attackedAt: DateTime!
  lastUpdatedAt: DateTime!
  note: String!  # latest note (post-amendments)
  attackers: [Address!]!
  victims: [Address!]!
  upvotes: Int!
  downvotes: Int!
  netScore: Int!  # upvotes - downvotes (computed)
  removed: Boolean!
  createdAtBlock: Int!
  createdAtTimestamp: DateTime!
  votes: [Vote!]! @derivedFrom(field: "post")
  edits: [Edit!]! @derivedFrom(field: "post")
}

# An address that appears as either attacker or victim.
type Address @entity {
  id: ID!  # the address
  attackerScore: BigInt!  # signed
  attackerAppearances: Int!
  isVictim: Boolean!
  postsAsAttacker: [Post!]!  # m2m
  postsAsVictim: [Post!]!  # m2m
}

# A single vote action (history).
type Vote @entity {
  id: ID!  # postId-voter
  post: Post!
  voter: Whitelister!
  direction: VoteDirection!
  blockNumber: Int!
  timestamp: DateTime!
}

enum VoteDirection {
  None
  Upvote
  Downvote
}

type WhitelistChange @entity {
  id: ID!  # txHash-logIndex
  addr: Whitelister!
  added: Boolean!
  blockNumber: Int!
  timestamp: DateTime!
}

type Edit @entity {
  id: ID!  # txHash-logIndex
  post: Post!
  kind: EditKind!
  newNote: String  # only for AmendNote
  addedAttackers: [Address!]  # only for AddAttackers
  addedVictims: [Address!]  # only for AddVictims
  blockNumber: Int!
  timestamp: DateTime!
}

enum EditKind {
  AmendNote
  AddAttackers
  AddVictims
}

type Removal @entity {
  id: ID!  # txHash-logIndex
  post: Post!
  blockNumber: Int!
  timestamp: DateTime!
}

type Upgrade @entity {
  id: ID!  # txHash-logIndex
  oldImpl: String  # nullable for first upgrade since we don't index pre-deploy
  newImpl: String!
  blockNumber: Int!
  timestamp: DateTime!
}
```

This is a sketch — final form during Phase 2.

## 7. Workflow

1. **Single PR for Phase 0** (monorepo restructure). Small, mechanical, no behavior change. Move existing files into `contracts/`. Add top-level README. Move plan files into `contracts/tasks/`.
2. **Single PR for Phase 1+2+3+4+5** (full squid scaffold + handlers + tests + dev experience). Self-contained — doesn't touch contracts.
3. **Phase 6 + 7 left for future work** (when contract deploys / when going to production).

## 8. Out of Scope

- Frontend (later workstream).
- IPFS hosting (Idea 4b — later).
- Cross-chain aggregation across multiple deployed instances (Phase 6).
- Production deploy / hosting / TLS / backup (Phase 7).
- Subsquid Cloud paid tier (only consider when self-host stops being cheap or convenient).

## 9. Approval

This plan needs operator sign-off on the open questions before implementation begins. Ideal sign-off:

- [ ] Initial target chain (Sepolia / Base Sepolia / wait for mainnet)
- [ ] Hosting target (local + VPS / specific cloud / other)
- [ ] GraphQL endpoint plan (api.thatsrekt.eth / .com / IP only)
- [ ] Multi-chain from day 1 or deferred (lean: deferred)

Once signed off:
- Spawn subagent for Phase 0 (monorepo restructure) → PR.
- After Phase 0 merged: spawn subagent for Phase 1-5 (squid build) → PR.
