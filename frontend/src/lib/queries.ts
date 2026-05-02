import { gqlClient } from './client'
import { mockFetchFeed, mockFetchPostDetail } from './mock'

const USE_MOCK = import.meta.env.VITE_USE_MOCK_DATA === 'true'
export const IS_MOCK_MODE = USE_MOCK

// ---- shared types (mirror schema.graphql) ----

export type ConfirmDirection = 'None' | 'Up' | 'Down'
export type EditKind = 'AmendNote' | 'AmendTitle' | 'AddAttackers' | 'AddVictims'

export interface AddressEntity {
  id: string
  attackerScore: string
  attackerAppearances?: number
  isVictim?: boolean
}

export interface PostAttackerLink {
  address: AddressEntity
}

export interface PostVictimLink {
  address: AddressEntity
}

export interface ChainInfo {
  chainId: number
  slug: string
  name: string
}

export interface FeedPost {
  id: string
  chain?: ChainInfo
  poster: { id: string }
  attackedAt: string
  /** Required headline (set on post(), updatable via amendTitle()). */
  title: string
  /** Free-form body — optional. */
  note: string
  confirmations: number
  disconfirmations: number
  netScore: number
  /**
   * Set true once governance has purged the post. Used to hide the post
   * from the feed entirely — the original content is intentionally NOT
   * surfaced (the point of purging is to scrub abusive material from
   * view, even though it remains readable on-chain).
   */
  purged: boolean
  createdAtTimestamp: string
  attackerLinks: PostAttackerLink[]
  victimLinks: PostVictimLink[]
}

export interface ConfirmationEntity {
  id: string
  confirmer: { id: string }
  oldDirection: ConfirmDirection
  newDirection: ConfirmDirection
  blockNumber: number
  timestamp: string
}

export interface EditEntity {
  id: string
  kind: EditKind
  newNote: string | null
  newTitle: string | null
  addedAttackers: string[] | null
  addedVictims: string[] | null
  blockNumber: number
  timestamp: string
}

export interface PostDetail {
  id: string
  poster: { id: string }
  attackedAt: string
  lastUpdatedAt: string
  title: string
  note: string
  confirmations: number
  disconfirmations: number
  netScore: number
  removed: boolean
  /** True iff governance has purged this post — UI must render a tombstone. */
  purged: boolean
  createdAtBlock: number
  createdAtTimestamp: string
  removedAtTimestamp: string | null
  purgedAtTimestamp: string | null
  attackerLinks: PostAttackerLink[]
  victimLinks: PostVictimLink[]
  confirmationLog: ConfirmationEntity[]
  edits: EditEntity[]
}

// ---- queries ----

// ---- sort options exposed in the UI ----

export type SortOption = 'newest' | 'oldest'

const SORT_TO_ORDER_BY: Record<SortOption, string> = {
  newest: 'createdAtBlock_DESC',
  oldest: 'createdAtBlock_ASC',
}

// Cross-chain feed query against the Mesh gateway. Mesh's
// `posts(limit, offset)` fans out to every enabled chain's squid,
// sort-merges by createdAtTimestamp DESC, and paginates server-side.
//
// Mesh filters governance-purged posts upstream (`where: { purged_eq: false }`),
// so this query trusts the gateway's gate. `purged` is still selected because
// the type is shared with other consumers (e.g. PostDetail tombstones) that
// key off it.
const FEED_QUERY = /* GraphQL */ `
  query Feed($limit: Int!, $offset: Int!, $chains: [String!]) {
    posts(limit: $limit, offset: $offset, chains: $chains) {
      items {
        id
        chain { chainId slug name }
        poster
        attackedAt
        title
        note
        confirmations
        disconfirmations
        netScore
        purged
        createdAtTimestamp
        attackers
        victims
      }
      totalCount
      hasMore
    }
  }
`

export interface FeedPage {
  items: FeedPost[]
  totalCount: number
  hasMore: boolean
  nextOffset: number | null
}

// Shape returned by the Mesh unified posts query — flatter than the squid's
// per-chain Post entity. We adapt it to FeedPost here to keep PostCard
// untouched.
interface MeshUnifiedPost {
  id: string
  chain: ChainInfo
  poster: string
  attackedAt: string
  title: string
  note: string
  confirmations: number
  disconfirmations: number
  netScore: number
  /** Optional on the wire — older Mesh deployments may not surface it yet. */
  purged?: boolean
  createdAtTimestamp: string
  attackers: string[]
  victims: string[]
}

// Per-chain detail: Mesh exposes the full upstream squid schema under a
// `<Prefix>_postById(id:...)` root field thanks to the prefix transforms.
// All on-chain data — confirmations, edits, address scores, etc. — is consumable
// here. We parse the chain prefix from the composite id and pick the
// matching root field at query time.
// Must match the `prefix` field in `mesh/src/chains.ts::CHAINS` for every
// actively-served chain. Missing entries here cause `/post/<slug>/<id>`
// detail pages to 404 even when the unified `posts(...)` query returns
// the post — the detail-page path goes through `<prefix>_postById` and
// fails fast on an unknown slug.
const SLUG_TO_PREFIX: Record<string, string> = {
  'anvil-eth': 'AnvilEth',
  'anvil-base': 'AnvilBase',
  sepolia: 'Sepolia',
  base: 'Base',
  'base-sepolia': 'BaseSepolia',
  optimism: 'Optimism',
}

const buildPostDetailQuery = (prefix: string): string => /* GraphQL */ `
  query PostDetail($id: String!) {
    ${prefix}_postById(id: $id) {
      id
      poster { id }
      attackedAt
      lastUpdatedAt
      title
      note
      confirmations
      disconfirmations
      netScore
      removed
      purged
      createdAtBlock
      createdAtTimestamp
      removedAtTimestamp
      purgedAtTimestamp
      attackerLinks {
        address {
          id
          attackerScore
          attackerAppearances
        }
      }
      victimLinks {
        address { id isVictim }
      }
      confirmationLog(orderBy: blockNumber_ASC) {
        id
        confirmer { id }
        oldDirection
        newDirection
        blockNumber
        timestamp
      }
      edits(orderBy: blockNumber_ASC) {
        id
        kind
        newNote
        newTitle
        addedAttackers
        addedVictims
        blockNumber
        timestamp
      }
    }
  }
`

// Composite id is `{slug}-{onchainId}`. Extract both parts.
export const splitCompositeId = (
  compositeId: string,
): { slug: string; onchainId: string } => {
  // Iterate the longest-known slugs first so 'anvil-base' beats 'base'.
  const slugs = Object.keys(SLUG_TO_PREFIX).sort((a, b) => b.length - a.length)
  for (const slug of slugs) {
    if (compositeId.startsWith(`${slug}-`)) {
      return { slug, onchainId: compositeId.slice(slug.length + 1) }
    }
  }
  // Fallback for legacy / direct-squid ids — assume base.
  return { slug: 'base', onchainId: compositeId }
}

export async function fetchFeed(
  limit = 50,
  sort: SortOption = 'newest',
): Promise<FeedPost[]> {
  // Legacy single-shot call — kept for callers that don't need pagination.
  const page = await fetchFeedPage(0, limit)
  return sort === 'oldest' ? page.items.slice().reverse() : page.items
}

export async function fetchFeedPage(
  offset: number,
  limit: number,
  /** Optional chain-slug list. Empty/undefined = all chains. */
  chainSlugs?: readonly string[],
): Promise<FeedPage> {
  if (USE_MOCK) {
    const all = await mockFetchFeed(1000, 'newest')
    const filtered = chainSlugs?.length
      ? all.filter((p) => p.chain && chainSlugs.includes(p.chain.slug))
      : all
    // Mock posts default to !purged (mock factory sets it false); kept
    // here to match the live-path contract.
    const visible = filtered.filter((p) => !p.purged)
    const items = visible.slice(offset, offset + limit)
    return {
      items,
      totalCount: visible.length,
      hasMore: offset + items.length < visible.length,
      nextOffset:
        offset + items.length < visible.length ? offset + items.length : null,
    }
  }
  const data = await gqlClient.request<{
    posts: { items: MeshUnifiedPost[]; totalCount: number; hasMore: boolean }
  }>(FEED_QUERY, {
    limit,
    offset,
    // Pass null (not undefined) when no filter; gql expects an explicit
    // value-or-null and graphql-request would otherwise send `undefined`.
    chains: chainSlugs?.length ? chainSlugs : null,
  })
  // Mesh filters purged posts upstream — pass through what the gateway
  // returned. No client-side filtering: that would silently shrink pages
  // and break pagination if upstream ever serves a purged post.
  const items = data.posts.items.map(adaptMeshPostToFeedPost)
  return {
    items,
    totalCount: data.posts.totalCount,
    hasMore: data.posts.hasMore,
    nextOffset: data.posts.hasMore ? offset + items.length : null,
  }
}

const adaptMeshPostToFeedPost = (p: MeshUnifiedPost): FeedPost => ({
  id: p.id,
  chain: p.chain,
  poster: { id: p.poster },
  attackedAt: p.attackedAt,
  title: p.title,
  note: p.note,
  confirmations: p.confirmations,
  disconfirmations: p.disconfirmations,
  netScore: p.netScore,
  purged: p.purged === true,
  createdAtTimestamp: p.createdAtTimestamp,
  attackerLinks: p.attackers.map((a) => ({ address: { id: a, attackerScore: '0' } })),
  victimLinks: p.victims.map((a) => ({ address: { id: a, attackerScore: '0' } })),
})

// Note: SORT_TO_ORDER_BY is no longer used by the Mesh path but kept for
// the legacy direct-squid mode and as documentation of the underlying
// Subsquid order keys.
void SORT_TO_ORDER_BY

export async function fetchPostDetail(id: string): Promise<PostDetail | null> {
  if (USE_MOCK) return mockFetchPostDetail(id)
  const { slug, onchainId } = splitCompositeId(id)
  const prefix = SLUG_TO_PREFIX[slug]
  if (!prefix) {
    throw new Error(`Unknown chain slug "${slug}" in post id "${id}"`)
  }
  const query = buildPostDetailQuery(prefix)
  const rootField = `${prefix}_postById`
  const data = await gqlClient.request<Record<string, PostDetail | null>>(query, {
    id: onchainId,
  })
  const post = data[rootField]
  if (!post) return null
  // Re-stamp the composite id so detail-page links and titles stay consistent.
  return { ...post, id }
}

// ---- contributors (whitelisters per chain) -----------------------------------

/** A single contributor entry — current or past. */
export interface Contributor {
  /** Lowercased address. */
  address: string
  /** ISO timestamp of first whitelist event. */
  firstWhitelistedAt: string | null
  /** ISO timestamp of last whitelist add/remove. */
  lastChangedAt: string | null
}

/** A single chain's whitelister set, split into active vs past. */
export interface ChainContributors {
  chainSlug: string
  /** Currently whitelisted (still able to post + confirm). */
  active: Contributor[]
  /** Previously whitelisted but since removed by governance. */
  past: Contributor[]
}

const ENABLED_CHAINS_QUERY = /* GraphQL */ `
  query EnabledChains {
    chains { slug }
  }
`

/**
 * Fetch the whitelisted contributor addresses for the given chain slugs.
 * Uses Mesh's prefixed `<Prefix>_whitelisters` queries.
 *
 * Mesh only exposes prefixed types/fields for chains in `MESH_CHAINS`
 * (its enabled set). We intersect the caller's requested slugs with
 * Mesh's `chains` query so we never reference a missing prefix.
 */
interface RawWhitelister {
  id: string
  isCurrentlyWhitelisted: boolean
  firstWhitelistedAt: string | null
  lastChangedAt: string | null
}

export async function fetchContributors(
  chainSlugs: readonly string[],
): Promise<ChainContributors[]> {
  if (USE_MOCK) {
    return chainSlugs.map((slug) => ({
      chainSlug: slug,
      active: [
        {
          address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
          firstWhitelistedAt: '2026-04-27T00:00:00.000Z',
          lastChangedAt: '2026-04-27T00:00:00.000Z',
        },
      ],
      past: [],
    }))
  }

  // Step 1: ask Mesh which chains are actually stitched.
  const enabled = await gqlClient.request<{ chains: { slug: string }[] }>(
    ENABLED_CHAINS_QUERY,
  )
  const enabledSet = new Set(enabled.chains.map((c) => c.slug))

  // Step 2: only build per-chain field aliases for slugs that are BOTH
  // requested AND known to Mesh. The remainder return empty groups so
  // the UI can still render the section.
  const queryable = chainSlugs.filter(
    (slug) => enabledSet.has(slug) && SLUG_TO_PREFIX[slug],
  )

  if (queryable.length === 0) {
    return chainSlugs.map((slug) => ({ chainSlug: slug, active: [], past: [] }))
  }

  const fields = queryable.map((slug) => {
    const prefix = SLUG_TO_PREFIX[slug]!
    const aliasKey = slug.replaceAll('-', '_')
    return `${aliasKey}: ${prefix}_whitelisters(orderBy: id_ASC) {
      id
      isCurrentlyWhitelisted
      firstWhitelistedAt
      lastChangedAt
    }`
  })

  const query = /* GraphQL */ `
    query Contributors {
      ${fields.join('\n      ')}
    }
  `

  const data = await gqlClient.request<
    Record<string, RawWhitelister[] | null | undefined>
  >(query)

  return chainSlugs.map((slug) => {
    const aliasKey = slug.replaceAll('-', '_')
    const rows = data[aliasKey] ?? []
    const active: Contributor[] = []
    const past: Contributor[] = []
    for (const row of rows) {
      const c: Contributor = {
        address: row.id,
        firstWhitelistedAt: row.firstWhitelistedAt,
        lastChangedAt: row.lastChangedAt,
      }
      if (row.isCurrentlyWhitelisted) {
        active.push(c)
      } else {
        past.push(c)
      }
    }
    return { chainSlug: slug, active, past }
  })
}

// =============================================================================
// Proposer leaderboard
// =============================================================================
// Global ranking of whitelisted posters by lifetime confirmation activity,
// aggregated across all chains the address has posted on. The Mesh
// resolver merges per-chain Proposer rows into one row per address.

/** A single row of the global proposer leaderboard. */
export interface ProposerEntry {
  /** Lowercased address — same on every chain (CREATE2 deterministic). */
  poster: string
  /** Lifetime count of posts authored, summed across all chains. */
  postCount: number
  /** Σ Post.confirmations across all this address's posts, all chains. */
  totalConfirmations: bigint
  /** Σ Post.disconfirmations across all this address's posts, all chains. */
  totalDisconfirmations: bigint
}

/** Sortable columns the leaderboard supports. */
export type ProposerOrderBy =
  | 'totalConfirmations'
  | 'postCount'
  | 'totalDisconfirmations'

const PROPOSER_LEADERBOARD_QUERY = /* GraphQL */ `
  query ProposerLeaderboard($limit: Int!, $offset: Int!, $orderBy: String!) {
    proposerLeaderboard(limit: $limit, offset: $offset, orderBy: $orderBy) {
      items {
        poster
        postCount
        totalConfirmations
        totalDisconfirmations
      }
      totalCount
      hasMore
    }
  }
`

interface RawProposerEntry {
  poster: string
  postCount: number
  totalConfirmations: string
  totalDisconfirmations: string
}

interface ProposerLeaderboardPage {
  items: ProposerEntry[]
  totalCount: number
  hasMore: boolean
}

// =============================================================================
// Indexer status (chain-tip vs squid-tip lag)
// =============================================================================
// Surfaces "is the data on this page up to date?" by comparing the indexer's
// last processed block to the chain tip read from a public RPC. The Mesh
// gateway exposes one `<Prefix>_squidStatus` per chain — we query the
// flagship (Base mainnet) since that's where production posts land.
//
// The chain-tip RPC is a single hard-coded routeme.sh endpoint matching
// `landing-page` / damm convention. Mesh status is hit via the existing
// `gqlClient`.

/** Public Base mainnet RPC — same load-balanced endpoint used by other DAMM tooling. */
const BASE_RPC_URL =
  'https://lb.routeme.sh/rpc/8453/3bd2e340-f97c-46b3-80ed-17975de5af89'

/** Average Base mainnet block time, used for human-readable lag formatting. */
export const BASE_BLOCK_TIME_SECONDS = 2

const BASE_SQUID_STATUS_QUERY = /* GraphQL */ `
  query BaseSquidStatus {
    Base_squidStatus {
      height
    }
  }
`

export interface IndexerStatus {
  /** Latest block on Base mainnet (from a public RPC). */
  chainTip: number
  /** Last block processed by the Subsquid indexer (from Mesh). */
  indexerHeight: number
  /** chainTip - indexerHeight (>= 0; clamped to 0 on slight overshoot). */
  lag: number
  /** When this snapshot was successfully fetched (Date.now() millis). */
  lastFetchedAt: number
}

const fetchBaseChainTip = async (): Promise<number> => {
  const res = await fetch(BASE_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_blockNumber',
      params: [],
      id: 1,
    }),
  })
  if (!res.ok) {
    throw new Error(`Base RPC ${res.status}: ${res.statusText}`)
  }
  const json = (await res.json()) as { result?: string; error?: { message: string } }
  if (json.error) throw new Error(`Base RPC error: ${json.error.message}`)
  if (typeof json.result !== 'string') {
    throw new Error('Base RPC returned no block number')
  }
  const tip = Number.parseInt(json.result, 16)
  if (!Number.isFinite(tip) || tip <= 0) {
    throw new Error(`Base RPC returned invalid block number: ${json.result}`)
  }
  return tip
}

const fetchBaseIndexerHeight = async (): Promise<number> => {
  const data = await gqlClient.request<{ Base_squidStatus: { height: number } | null }>(
    BASE_SQUID_STATUS_QUERY,
  )
  const status = data.Base_squidStatus
  if (!status || typeof status.height !== 'number') {
    throw new Error('Base_squidStatus returned no height')
  }
  return status.height
}

/**
 * Fetch indexer status: chain tip + squid height in parallel.
 *
 * Both legs must succeed — partial state is misleading (a green dot on
 * "we don't actually know the chain tip" is worse than a gray "unknown").
 * The caller decides how to render `isError`.
 */
export async function fetchIndexerStatus(): Promise<IndexerStatus> {
  if (USE_MOCK) {
    // Mock mode: pretend we're caught up.
    const tip = 45_400_000
    return {
      chainTip: tip,
      indexerHeight: tip,
      lag: 0,
      lastFetchedAt: Date.now(),
    }
  }
  const [chainTip, indexerHeight] = await Promise.all([
    fetchBaseChainTip(),
    fetchBaseIndexerHeight(),
  ])
  // Indexer can momentarily report a height equal to tip + 1 in rare race
  // conditions (RPC and Mesh see different heads). Clamp to 0 so the UI
  // never shows a negative lag.
  const lag = Math.max(0, chainTip - indexerHeight)
  return {
    chainTip,
    indexerHeight,
    lag,
    lastFetchedAt: Date.now(),
  }
}

export async function fetchProposerLeaderboard(opts: {
  limit?: number
  offset?: number
  orderBy?: ProposerOrderBy
} = {}): Promise<ProposerLeaderboardPage> {
  const limit = opts.limit ?? 25
  const offset = opts.offset ?? 0
  const orderBy = opts.orderBy ?? 'totalConfirmations'

  if (USE_MOCK) {
    return {
      items: [
        {
          poster: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
          postCount: 12,
          totalConfirmations: 47n,
          totalDisconfirmations: 3n,
        },
        {
          poster: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
          postCount: 5,
          totalConfirmations: 11n,
          totalDisconfirmations: 8n,
        },
      ],
      totalCount: 2,
      hasMore: false,
    }
  }

  const data = await gqlClient.request<{
    proposerLeaderboard: {
      items: RawProposerEntry[]
      totalCount: number
      hasMore: boolean
    }
  }>(PROPOSER_LEADERBOARD_QUERY, { limit, offset, orderBy })

  return {
    items: data.proposerLeaderboard.items.map((r) => ({
      poster: r.poster,
      postCount: r.postCount,
      totalConfirmations: BigInt(r.totalConfirmations),
      totalDisconfirmations: BigInt(r.totalDisconfirmations),
    })),
    totalCount: data.proposerLeaderboard.totalCount,
    hasMore: data.proposerLeaderboard.hasMore,
  }
}
