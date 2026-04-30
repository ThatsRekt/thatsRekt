# Archive posts on the frontend feed

**Status:** Approved 2026-04-30. Implementation pending.
**Scope:** Frontend-only. No contract / indexer / mesh / relay changes.

## Goal

Render the curated dataset at `data/historic-incidents.json` (31 pre-platform
DeFi attacks) as read-only "archive" cards on the feed, alongside live
on-chain posts. Archive entries are **never** posted on-chain — they exist
only as static frontend content.

The supersedes `tasks/historic-data-seed.md`, which planned to seed the
contract with these incidents. That plan is dropped: the on-chain registry
is for new attacks going forward; old attacks live as a frontend archive.

## Layout

Single `/` feed, two stacked sections:

```
┌────────────────────────────────┐
│   live on-chain posts          │  sorted by createdAtTimestamp
│   (newest first by default)    │  (chain filter applies)
├────────────────────────────────┤
│   ═══ archive · pre-platform   │  divider only when both sections non-empty
├────────────────────────────────┤
│   archive cards                │  sorted by attackedAt
│   (newest first by default)    │  (chain filter applies)
└────────────────────────────────┘
```

Section order is fixed: **live always above archive.** Sort direction
(`newest`/`oldest`) flips order *within* each section but never swaps the
sections themselves.

## Controls

The existing FilterBar gains one control between `sort:` and `chain:`:

```
sort: [newest] [oldest]    [✓ show archive (i)]    chain: [all chains ▾]
```

- **Toggle:** checkbox-style button matching the sort tabs' aesthetic.
  Defaults `on`. Persists via URL search param (`?archive=off` when hidden).
- **Tooltip** on the `(i)` icon, native `title=`:
  > Pre-platform attacks compiled by the community. Archive posts are
  > off-chain context — they're not posted to the registry and can't be
  > confirmed/disconfirmed.

## Sort + filter interaction

| sort | toggle | chain | live section | divider | archive section |
|---|---|---|---|---|---|
| newest | on | all | DESC by `createdAtTimestamp` | shown | DESC by `attackedAt` (2024 → 2016) |
| oldest | on | all | ASC | shown | ASC by `attackedAt` (2016 → 2024) |
| newest | off | all | DESC | hidden | not rendered |
| newest | on | base | live filtered to base | hidden* | hidden (0 base archives) |
| newest | on | ethereum | empty | hidden | full archive DESC |

\* divider hides whenever either section is empty.

## Data layer

- **Source of truth:** `data/historic-incidents.json` at the repo root.
- **Frontend copy:** `frontend/src/data/historic-incidents.json` —
  duplicated. Tagged with a comment in `data/README.md` instructing
  future editors to update both. Dataset is essentially frozen per its
  own README, so duplication is acceptable.
- **Type:** `ArchivePost` interface in `frontend/src/lib/archive.ts`
  mirrors the JSON schema exactly:

  ```ts
  interface ArchivePost {
    readonly id: string                    // "the-dao-2016"
    readonly protocol: string
    readonly chain: string                 // "ethereum" / "arbitrum" / etc.
    readonly attackedAt: string            // ISO 8601
    readonly title: string
    readonly attackers: readonly string[]  // 0x lowercased
    readonly victims: readonly string[]
    readonly note: string
    readonly sourceUrl: string
    readonly amountUsd: number
    readonly chainsAffected?: readonly string[]
  }
  ```

- **Helper:** `selectArchive({ chainSlug, sort })` — pure function,
  filters by chain and returns sorted array. Solana entries (informational
  only per the dataset README) are excluded at import time. No state, no
  fetch.

## Chain registry extension

`frontend/src/lib/chains.ts` `CHAINS` registry grows by four entries
(archive-only chains):

| slug | chainId | explorer | liveIndexed |
|---|---|---|---|
| `ethereum` | 1 | etherscan.io | false |
| `arbitrum` | 42161 | arbiscan.io | false |
| `bsc` | 56 | bscscan.com | false |
| `blast` | 81457 | blastscan.io | false |

Existing live chains gain `liveIndexed: true`. `visibleChains()` returns
all of them — chain selector now exposes the union.

`solana` is intentionally absent from the frontend registry. The single
Solana entry in the dataset (Mango Markets) is informational and will be
excluded by `selectArchive()` since no archive-chain slug matches.

Side effect: a user who picks `ethereum` sees an empty live section
followed by the full historical archive. That's correct — they came to
browse the archive of ETH hacks.

## Component changes

### `PostCard`

Currently takes `{ post: FeedPost }`. Refactor to a discriminated union:

```ts
type PostCardItem =
  | { kind: 'live'; post: FeedPost }
  | { kind: 'archive'; post: ArchivePost }
```

Same skeleton, three branched bits:

| Element | Live | Archive |
|---|---|---|
| Top-row badges | `ChainBadge` + `#id` | `ChainBadge` + `[ARCHIVE]` red-bordered chip |
| Headline link | `/post/{id}` | `/post/archive-{slug}` |
| Body | `note` | `note` (full text shown via existing `line-clamp-3`) |
| Metadata row | `[poster: …] · [N attackers] · [M victims] · score` | `[$XXM] · [N attackers] · [M victims] · [src ↗]` |
| `more →` | detail page link | detail page link |

### `PostDetail`

Detect `id.startsWith('archive-')` at the top. If true, render a sibling
component `ArchiveDetail` instead of the live detail layout.

`ArchiveDetail` reuses the same shell:

- Header: `[#archive-{slug}]` + `ChainBadge` + neutral-grey `archived`
  status chip + `attacked X ago`
- Title (full headline, same typography as live)
- Field grid: `[source] → rekt.news/...`, `[amount] $XXM`,
  `[primary chain] ethereum` (and `[also affected] bsc, polygon` when
  `chainsAffected` is set)
- `note` section — full text
- `attackers` and `victims` sections — reuse existing `AddressLabel`
  exactly, so clicking an archive attacker lands on the same address
  profile as clicking a live attacker. **This is the value.**
- No timeline, no confirmation log, no edit history, no `lastUpdatedAt`,
  no retract/active distinction.

`fetchPostDetail` dispatches on the `archive-` prefix → in-memory lookup
against the imported JSON → returns synthesized data. No network call.

### `Feed` page

The query layer keeps `useInfiniteQuery` for live posts as today.
Archive selection is a `useMemo` over the static array — pure, no async.

`<FeedList>` becomes:

```tsx
<>
  <LiveSection posts={live} ... />
  {showDivider && <ArchiveDivider />}
  <ArchiveSection posts={archive} />
</>
```

Where `showDivider = liveSection.nonEmpty && archiveSection.nonEmpty`.

`load more` button stays inside `<LiveSection>` for paginating live posts;
it doesn't appear in the archive section because the archive is
fully-loaded in-memory.

## Routing

Add no new route — `/post/:id` already catches `archive-the-dao-2016`
because `:id` is a wildcard. Disambiguation happens inside the
`PostDetail` component.

## Empty states

| State | Behavior |
|---|---|
| live empty + archive on + has archive matches | Render archive section directly (no divider, no "no posts" message) |
| live empty + archive on + no archive matches | Existing `EmptyState` |
| live empty + archive off | Existing `EmptyState` |
| live populated + archive on + no archive matches (e.g. chain=base) | Live only, no divider |

The first row is the launch-day case: zero on-chain posts → user sees the
archive, contextualized by a small banner above the archive section: *"No
on-chain posts yet. Below: pre-platform attacks compiled by the
community."*

## Testing

- **Typecheck:** `pnpm typecheck` — the discriminated union forces every
  call site of `PostCard` and `fetchPostDetail` to handle both variants
  exhaustively.
- **Manual:** dev server + browser walkthrough of the matrix above.
- **Test framework:** the frontend has no test framework set up today.
  Introducing `vitest` is a separate concern (small but out-of-scope
  here). Follow-up PR: add vitest + a unit test for `selectArchive`
  covering the four sort × chainFilter quadrants and the solana-skip.

## Out of scope (deferred)

- Persistence of toggle/sort/chain in localStorage beyond URL params.
- "Archive only" mode (option C from brainstorming) — could add later as
  a third toggle state if user research demands it.
- Translating attackers/victims from archive entries into per-address
  profiles. The address-label click already works; building a unified
  address-profile page that aggregates archive + on-chain mentions is a
  separate feature.
- Sync script keeping `data/historic-incidents.json` and
  `frontend/src/data/historic-incidents.json` in lockstep. One-off
  duplication is fine; revisit if the dataset becomes mutable.

## File list

**New:**
- `frontend/src/data/historic-incidents.json` (copy of repo-root file)
- `frontend/src/lib/archive.ts` — types + `selectArchive` helper
- `frontend/src/components/ArchiveDivider.tsx`
- `frontend/src/components/ArchiveDetail.tsx`

**Modified:**
- `frontend/src/lib/chains.ts` — extend `CHAINS`, add `liveIndexed` flag
- `frontend/src/components/PostCard.tsx` — discriminated-union props
- `frontend/src/pages/Feed.tsx` — toggle, divider, archive section
- `frontend/src/pages/PostDetail.tsx` — branch on `archive-` prefix
- `frontend/src/lib/queries.ts` — `fetchPostDetail` archive branch
- `frontend/src/hooks/useChainFilter.ts` *(maybe — if archive-toggle
  state lives next to chain filter for parity)*
- `data/README.md` — add note about frontend duplicate

## Implementation order

1. Data layer + chain registry — types compile, no UI changes.
2. PostCard discriminated-union refactor — existing live cards still
   render identically.
3. ArchiveDetail + `fetchPostDetail` archive branch.
4. Feed toggle, divider, archive section integration.
5. Tests + typecheck + build.
