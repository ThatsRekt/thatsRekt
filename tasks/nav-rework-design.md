# Nav rework — feed · leaderboard · about · docs

**Status:** Approved 2026-04-30. Shipping in 3 sequential PRs.

## Final shape

```
header: thats[REKT]    feed · leaderboard · about · docs
footer:                                            github (existing)
```

| Route | Component | Source |
|---|---|---|
| `/` | `Feed` | unchanged |
| `/post/:id` | `PostDetail` | unchanged |
| `/leaderboard` | `Leaderboard` (new) | extracted from Contributors |
| `/about` | `About` (new) | merges Donate + Contributors content |
| `/docs` | `Docs` (new) | internal page (not external link) |
| ~~`/contributors`~~ | (deleted) | content moved to /about + /leaderboard |
| ~~`/donate`~~ | (deleted) | content moved to /about |

The github link drops out of the header. The footer's existing "source on github" stays. No `/contributors` or `/donate` redirects — the site has no public traffic to preserve at this stage; cleaner to just delete.

## About page composition

Order is the narrative — what → who runs it → who can post → how to support:

1. **Hero** — public-good copy from the existing `Donate` page ("reads are open / 7-day timelock / shared infrastructure")
2. **Maintainers** — existing `<Maintainers>` component, lifted unchanged
3. **Contributors** (whitelisters per chain) — existing chain-tabs + `<ChainSection>` block, lifted unchanged
4. **Donate** — existing `<DonateAddress>` block + supporting prose

## Leaderboard page composition

Tiny: lift `<ProposerLeaderboard />` into its own file. Add a small page header explaining what the leaderboard is.

## Docs page composition

Single scrollable JSX page (Option B from brainstorming — internal, ships now, can migrate to a docs site later when it outgrows the page). Sections:

1. **What is thatsRekt** — 2 short paragraphs
2. **How posts work** — three subsections: whitelisters / governance / integrators
3. **Integrating** — three concrete code blocks:
   - From a Solidity contract: `IThatsRekt(0x…).attackerScore(...)`
   - From a dApp / indexer: GraphQL query against the public Mesh gateway
   - From an off-chain detector: pointer to relay/README.md
4. **Reference** — per-chain proxy addresses, public Mesh GraphQL endpoint, GitHub repo link

Aesthetic: rekt brutalist — `font-black uppercase tracking-widest` headers, monospace inline code, sharp `border-2 border-black` blocks for code samples, no syntax-highlighting library (would bloat the bundle for one page; plain `<pre><code>` is fine).

**Out of scope:** real syntax highlighting, MDX, search, copy-to-clipboard buttons on code blocks, multi-page docs structure. All easy follow-ups; the page will tell us when it's ready for them.

## File plan

**New:**
- `frontend/src/pages/Leaderboard.tsx` (PR A)
- `frontend/src/components/Maintainers.tsx` (PR A — extracted)
- `frontend/src/components/WhitelistersByChain.tsx` (PR A — extracted)
- `frontend/src/pages/About.tsx` (PR B)
- `frontend/src/pages/Docs.tsx` (PR C)

**Deleted:**
- `frontend/src/pages/Contributors.tsx` (PR B)
- `frontend/src/pages/Donate.tsx` (PR B)

**Modified across PRs:**
- `frontend/src/App.tsx` — routes + nav, evolving across all 3 PRs

## Shipping plan — three sequential PRs

### PR A: Extract Leaderboard
- Extract `Maintainers` + `WhitelistersByChain` into their own component files (pure refactor — Contributors still imports them, behavior unchanged).
- Lift `<ProposerLeaderboard />` body into `pages/Leaderboard.tsx`.
- Add `/leaderboard` route + nav link.
- Drop `<ProposerLeaderboard />` from the Contributors page (it now lives only on `/leaderboard`).
- After this PR: nav is `feed · contributors · leaderboard · donate · github`. The /contributors page in transition just shows Maintainers + WhitelistersByChain.

### PR B: About page replaces Contributors + Donate
- Add `pages/About.tsx` composing Hero + Maintainers + WhitelistersByChain + DonateAddress.
- Add `/about` route + nav link.
- Delete `/contributors` and `/donate` routes + their `pages/*.tsx` files.
- Drop `contributors` and `donate` nav entries.
- Move the `DonateAddress` component out of `pages/Donate.tsx` into `components/DonateAddress.tsx` before deleting Donate.tsx.
- After this PR: nav is `feed · leaderboard · about · github`.

### PR C: Docs page
- Add `pages/Docs.tsx` with the four sections.
- Add `/docs` route + nav link.
- Drop the `github` link from header nav (footer keeps it).
- After this PR: nav reaches final shape `feed · leaderboard · about · docs`.

Each PR leaves the site in a working state — typecheck passes, build clean, no broken links from earlier-merged work.
