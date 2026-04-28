import { gqlClient } from './client'
import { mockFetchFeed, mockFetchPostDetail } from './mock'

const USE_MOCK = import.meta.env.VITE_USE_MOCK_DATA === 'true'
export const IS_MOCK_MODE = USE_MOCK

// ---- shared types (mirror schema.graphql) ----

export type VoteDirection = 'None' | 'Upvote' | 'Downvote'
export type EditKind = 'AmendNote' | 'AddAttackers' | 'AddVictims'

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
  note: string
  upvotes: number
  downvotes: number
  netScore: number
  createdAtTimestamp: string
  attackerLinks: PostAttackerLink[]
  victimLinks: PostVictimLink[]
}

export interface VoteEntity {
  id: string
  voter: { id: string }
  oldDirection: VoteDirection
  newDirection: VoteDirection
  blockNumber: number
  timestamp: string
}

export interface EditEntity {
  id: string
  kind: EditKind
  newNote: string | null
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
  note: string
  upvotes: number
  downvotes: number
  netScore: number
  removed: boolean
  createdAtBlock: number
  createdAtTimestamp: string
  removedAtTimestamp: string | null
  attackerLinks: PostAttackerLink[]
  victimLinks: PostVictimLink[]
  votes: VoteEntity[]
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
const FEED_QUERY = /* GraphQL */ `
  query Feed($limit: Int!, $offset: Int!, $chains: [String!]) {
    posts(limit: $limit, offset: $offset, chains: $chains) {
      items {
        id
        chain { chainId slug name }
        poster
        attackedAt
        note
        upvotes
        downvotes
        netScore
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
  note: string
  upvotes: number
  downvotes: number
  netScore: number
  createdAtTimestamp: string
  attackers: string[]
  victims: string[]
}

// Per-chain detail: Mesh exposes the full upstream squid schema under a
// `<Prefix>_postById(id:...)` root field thanks to the prefix transforms.
// All on-chain data — votes, edits, address scores, etc. — is consumable
// here. We parse the chain prefix from the composite id and pick the
// matching root field at query time.
const SLUG_TO_PREFIX: Record<string, string> = {
  'anvil-eth': 'AnvilEth',
  'anvil-base': 'AnvilBase',
  sepolia: 'Sepolia',
  base: 'Base',
}

const buildPostDetailQuery = (prefix: string): string => /* GraphQL */ `
  query PostDetail($id: String!) {
    ${prefix}_postById(id: $id) {
      id
      poster { id }
      attackedAt
      lastUpdatedAt
      note
      upvotes
      downvotes
      netScore
      removed
      createdAtBlock
      createdAtTimestamp
      removedAtTimestamp
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
      votes(orderBy: blockNumber_ASC) {
        id
        voter { id }
        oldDirection
        newDirection
        blockNumber
        timestamp
      }
      edits(orderBy: blockNumber_ASC) {
        id
        kind
        newNote
        addedAttackers
        addedVictims
        blockNumber
        timestamp
      }
    }
  }
`

// Composite id is `{slug}-{onchainId}`. Extract both parts.
const splitCompositeId = (compositeId: string): { slug: string; onchainId: string } => {
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
    const items = filtered.slice(offset, offset + limit)
    return {
      items,
      totalCount: filtered.length,
      hasMore: offset + items.length < filtered.length,
      nextOffset:
        offset + items.length < filtered.length ? offset + items.length : null,
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
  note: p.note,
  upvotes: p.upvotes,
  downvotes: p.downvotes,
  netScore: p.netScore,
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
  /** Currently whitelisted (still able to post + vote). */
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
