/**
 * thatsRekt Mesh gateway.
 *
 * Stitches the per-chain Subsquid GraphQL endpoints into one unified
 * schema. Per-chain queries are exposed under a `<Prefix>_*` namespace
 * (e.g. `Anvil_posts`, `Sepolia_posts`, `Base_posts`); cross-chain
 * queries are added on top via additionalResolvers (`posts(limit)`
 * fans out and sort-merges; `chains` returns the registry).
 *
 * Runs as a stateless Yoga server on port `${PORT:-4350}`. Trivially
 * replaceable — no state to lose if it crashes.
 */
import { parse, print } from 'graphql'
import type { DocumentNode, ExecutionResult } from 'graphql'
import { stitchSchemas } from '@graphql-tools/stitch'
import { schemaFromExecutor, RenameRootFields, RenameTypes } from '@graphql-tools/wrap'
import type { SubschemaConfig } from '@graphql-tools/delegate'
import type { Executor } from '@graphql-tools/utils'
import { createYoga } from 'graphql-yoga'
import { createServer } from 'node:http'
import { z } from 'zod'

import { enabledChains, type ChainEntry } from './chains.js'
import {
  handleOgImageRoute,
  handleOgRoute,
  isOgImageRoute,
  isOgRoute,
} from './og.js'
import { handleSitemapAttacksRoute, isSitemapAttacksRoute } from './sitemap.js'

// ---------------------------------------------------------------------------
// GraphiQL default query
// ---------------------------------------------------------------------------
//
// Pre-filled into the in-browser GraphiQL editor at /graphql. Keeps the
// first-time visitor journey tight: hit the URL → see a real query →
// press Run → get data. The default Yoga buffer is all comments, which
// throws "Unexpected EOF" if the visitor presses Run before typing.
const GRAPHIQL_DEFAULT_QUERY = `# thatsRekt — public on-chain hack alert registry.
# https://thatsrekt.com — site · https://thatsrekt.com/docs — integrator docs
#
# This sample fetches the latest 10 alerts merged across every indexed
# chain. Press the ▶ button (or Cmd-Enter / Ctrl-Enter) to run.

query LatestAlerts {
  posts(limit: 10) {
    items {
      id
      chain { slug name }
      title
      poster
      attackedAt
      attackers
      victims
      confirmations
      disconfirmations
      netScore
    }
    totalCount
  }
}
`


// ---------------------------------------------------------------------------
// Per-upstream executor
// ---------------------------------------------------------------------------

const makeExecutor = (endpoint: string): Executor => {
  // The Executor interface is generic and supports streaming results;
  // we always return a single ExecutionResult, so we cast at the boundary.
  return (async ({ document, variables }) => {
    const query = print(document as DocumentNode)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) {
      throw new Error(`Upstream ${endpoint} returned ${res.status}: ${await res.text()}`)
    }
    return (await res.json()) as ExecutionResult
  }) as Executor
}

// Wait for an upstream to be reachable. The squid GraphQL servers can take
// a few seconds after compose start, and the Mesh service must not crash
// just because it raced ahead.
const waitForUpstream = async (chain: ChainEntry, timeoutMs = 60_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(chain.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      })
      if (res.ok) return
      lastErr = new Error(`status ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(
    `Upstream ${chain.slug} (${chain.endpoint}) not reachable after ${timeoutMs}ms: ${lastErr}`,
  )
}

// ---------------------------------------------------------------------------
// Build a stitched schema
// ---------------------------------------------------------------------------

const buildSubschema = async (chain: ChainEntry): Promise<SubschemaConfig> => {
  const executor = makeExecutor(chain.endpoint)
  const schema = await schemaFromExecutor(executor)
  return {
    schema,
    executor,
    transforms: [
      // Order matters: rename types first (so root fields' return types
      // are renamed too), then rename root field names.
      new RenameTypes((name) => `${chain.prefix}${name}`),
      new RenameRootFields((_op, name) => `${chain.prefix}${name}`),
    ],
  }
}

// Cross-chain unified resolvers. The `posts` query fans out to every
// chain's `*_posts(limit:)`, normalizes results, and sort-merges by
// timestamp. The `chains` query just returns the registry.
const additionalTypeDefs = /* GraphQL */ `
  type ChainInfo {
    chainId: Int!
    slug: String!
    name: String!
  }

  """A post normalized across chains. \`chain\` identifies which chain it came from."""
  type UnifiedPost {
    """Composite id: \`{chainSlug}-{onchainPostId}\`."""
    id: ID!
    chain: ChainInfo!
    poster: String!
    attackedAt: String!
    """Required headline — set on post(), updatable via amendTitle()."""
    title: String!
    """Free-form note body — optional, updatable via amendNote()."""
    note: String!
    netScore: Int!
    confirmations: Int!
    disconfirmations: Int!
    removed: Boolean!
    """True iff governance has purged this post. The gateway filters purged posts out of \`posts(...)\` server-side; surfaced here so detail-fetch paths can defensively render a tombstone."""
    purged: Boolean!
    createdAtBlock: Int!
    createdAtTimestamp: String!
    lastUpdatedAt: String!
    """Plain address strings for attackers."""
    attackers: [String!]!
    """Plain address strings for victims."""
    victims: [String!]!
  }

  type UnifiedPostsPage {
    """The slice of posts for this page."""
    items: [UnifiedPost!]!
    """Total post count summed across all enabled chains. Cheap upper bound for the UI's pagination."""
    totalCount: Int!
    """True if more posts exist beyond \`offset + limit\`."""
    hasMore: Boolean!
  }

  """One row of the global proposer leaderboard. Stats are summed across every chain the address has posted on (CREATE2 deterministic deploy + same EOA whitelisted on multiple chains → same lowercased address everywhere)."""
  type ProposerLeaderboardEntry {
    """Lowercased poster address."""
    poster: String!
    """Lifetime count of posts this address has authored, summed across all chains."""
    postCount: Int!
    """Σ Post.confirmations across all this address's posts, all chains."""
    totalConfirmations: String!
    """Σ Post.disconfirmations across all this address's posts, all chains."""
    totalDisconfirmations: String!
  }

  type ProposerLeaderboardPage {
    items: [ProposerLeaderboardEntry!]!
    """Total distinct posters with at least one Proposer row across all chains."""
    totalCount: Int!
    """True if more posters exist beyond \`offset + limit\`."""
    hasMore: Boolean!
  }

  extend type Query {
    """Chains served by this gateway."""
    chains: [ChainInfo!]!

    """Cross-chain feed page. Posts are sort-merged by createdAtTimestamp DESC across all enabled chains. Pass \`chains: [\"anvil-base\"]\` to scope to a single chain (or omit to query all). Use \`offset + limit\` for pagination."""
    posts(limit: Int = 25, offset: Int = 0, chains: [String!]): UnifiedPostsPage!

    """Global proposer leaderboard. Aggregates per-chain Proposer rows by lowercased address. \`orderBy\` is one of: \`postCount\`, \`totalConfirmations\` (default), \`totalDisconfirmations\`."""
    proposerLeaderboard(
      limit: Int = 25,
      offset: Int = 0,
      orderBy: String = "totalConfirmations"
    ): ProposerLeaderboardPage!
  }
`

// zod-validated shape of a post as returned by the upstream squid
// GraphQL servers. Parsing through this catches schema drift at the
// boundary with a clear error rather than crashing deep in a resolver.
const AddressLink = z.object({
  address: z.object({ id: z.string() }),
})

const RawPost = z.object({
  id: z.string(),
  poster: z.object({ id: z.string() }),
  attackedAt: z.string(),       // DateTime / BigInt scalars come over as strings
  title: z.string(),
  note: z.string(),
  netScore: z.number().int(),
  confirmations: z.number().int(),
  disconfirmations: z.number().int(),
  removed: z.boolean(),
  // `purged` is optional on the wire so the gateway tolerates upstream
  // squids that haven't run the purge migration yet — they simply won't
  // project the column, and we coalesce `undefined` to `false` below.
  purged: z.boolean().optional(),
  createdAtBlock: z.number().int(),
  createdAtTimestamp: z.string(),
  lastUpdatedAt: z.string(),
  attackerLinks: z.array(AddressLink),
  victimLinks: z.array(AddressLink),
})
type RawPost = z.infer<typeof RawPost>

const FetchPostsResponse = z.object({
  posts: z.array(RawPost),
})

// `purged` is filtered out at the upstream squid via `where: { purged_eq: false }`
// so we don't pull rows we'd just throw away. We also project the field for
// downstream consumers (so the unified `posts(...)` resolver can fall through
// to a tombstone rendering should a stale row sneak in).
const FETCH_POSTS_QUERY = /* GraphQL */ `
  query FetchPosts($limit: Int!) {
    posts(
      orderBy: createdAtBlock_DESC
      limit: $limit
      where: { purged_eq: false }
    ) {
      id
      poster { id }
      attackedAt
      title
      note
      netScore
      confirmations
      disconfirmations
      removed
      purged
      createdAtBlock
      createdAtTimestamp
      lastUpdatedAt
      attackerLinks { address { id } }
      victimLinks { address { id } }
    }
  }
`

// Cheap server-side count for pagination UX. Each squid exposes
// `postsConnection.totalCount` (Subsquid auto-generated). Per-chain calls
// in parallel; sum is the upper bound for the unified feed. We filter
// purged posts out of the count so "showing X of Y" stays honest.
const COUNT_POSTS_QUERY = /* GraphQL */ `
  query CountPosts {
    postsConnection(
      orderBy: createdAtBlock_DESC
      where: { purged_eq: false }
    ) { totalCount }
  }
`

const CountPostsResponse = z.object({
  postsConnection: z.object({ totalCount: z.number().int() }),
})

// --- Proposer leaderboard wire shapes ---
//
// Per-chain Proposer rows fetched in bulk and merged in Mesh. The
// whitelister set is small (~tens) so pulling all of them per chain is
// cheap; we don't paginate the per-chain query.
const RawProposer = z.object({
  id: z.string(),
  postCount: z.number().int(),
  totalConfirmations: z.string(),       // BigInt scalar arrives as string
  totalDisconfirmations: z.string(),
})
type RawProposer = z.infer<typeof RawProposer>

const FetchProposersResponse = z.object({
  proposers: z.array(RawProposer),
})

const FETCH_PROPOSERS_QUERY = /* GraphQL */ `
  query FetchProposers {
    proposers(orderBy: id_ASC) {
      id
      postCount
      totalConfirmations
      totalDisconfirmations
    }
  }
`

// Aggregated stats per address across all chains. BigInts accumulate as
// `bigint` (JS native) for safe addition; serialized as decimal strings
// at the GraphQL boundary.
type ProposerAgg = {
  poster: string
  postCount: number
  totalConfirmations: bigint
  totalDisconfirmations: bigint
}

const PROPOSER_ORDERINGS = ['postCount', 'totalConfirmations', 'totalDisconfirmations'] as const
type ProposerOrderBy = (typeof PROPOSER_ORDERINGS)[number]
const isProposerOrderBy = (s: string): s is ProposerOrderBy =>
  (PROPOSER_ORDERINGS as readonly string[]).includes(s)

const buildAdditionalResolvers = (chains: readonly ChainEntry[]) => ({
  Query: {
    chains: () =>
      chains.map((c) => ({ chainId: c.chainId, slug: c.slug, name: c.name })),

    posts: async (
      _root: unknown,
      args: { limit: number; offset: number; chains?: string[] | null },
    ) => {
      const { limit, offset } = args
      // Optional chain filter: when provided, only fan out to those
      // chains. Unknown slugs are silently ignored (the GraphQL filter
      // arg is opaque from upstream's perspective).
      const filterSet = args.chains?.length
        ? new Set(args.chains)
        : null
      const activeChains = filterSet
        ? chains.filter((c) => filterSet.has(c.slug))
        : chains

      // Each chain must yield enough rows to cover (offset + limit) after
      // merge. We over-fetch (offset + limit) per chain — generous upper
      // bound. Cursor-based pagination would be tighter; deferred.
      const fetchPerChain = offset + limit
      const results = await Promise.allSettled(
        activeChains.map(async (c) => {
          const executor = makeExecutor(c.endpoint)
          const raw = await executor({
            document: parseQueryToDocument(FETCH_POSTS_QUERY),
            variables: { limit: fetchPerChain },
            context: {},
          }) as ExecutionResult
          if (raw.errors?.length) {
            console.error(`[mesh] ${c.slug} returned errors:`, raw.errors)
            return [] as { chain: ChainEntry; post: RawPost }[]
          }
          const parsed = FetchPostsResponse.safeParse(raw.data)
          if (!parsed.success) {
            console.error(
              `[mesh] ${c.slug} response failed schema validation:`,
              parsed.error.flatten(),
            )
            return [] as { chain: ChainEntry; post: RawPost }[]
          }
          return parsed.data.posts.map((post) => ({ chain: c, post }))
        }),
      )

      const merged = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
      // Sort by createdAtTimestamp DESC for stable cross-chain ordering
      // (createdAtBlock isn't comparable across chains; timestamps are).
      merged.sort((a, b) => {
        const ta = new Date(a.post.createdAtTimestamp).getTime()
        const tb = new Date(b.post.createdAtTimestamp).getTime()
        if (ta !== tb) return tb - ta
        return a.chain.chainId - b.chain.chainId
      })

      // Per-chain count for totalCount + hasMore. Counts only the chains
      // currently in scope (so a single-chain filter shows that chain's
      // count, not the global total).
      const countResults = await Promise.allSettled(
        activeChains.map(async (c) => {
          const executor = makeExecutor(c.endpoint)
          const raw = await executor({
            document: parseQueryToDocument(COUNT_POSTS_QUERY),
            variables: {},
            context: {},
          }) as ExecutionResult
          if (raw.errors?.length) return 0
          const parsed = CountPostsResponse.safeParse(raw.data)
          return parsed.success ? parsed.data.postsConnection.totalCount : 0
        }),
      )
      const totalCount = countResults
        .map((r) => (r.status === 'fulfilled' ? r.value : 0))
        .reduce((a, b) => a + b, 0)

      const slice = merged.slice(offset, offset + limit)
      const hasMore = offset + slice.length < totalCount

      const items = slice.map(({ chain, post }) => ({
        id: `${chain.slug}-${post.id}`,
        chain: { chainId: chain.chainId, slug: chain.slug, name: chain.name },
        poster: post.poster.id,
        attackedAt: post.attackedAt,
        title: post.title,
        note: post.note,
        netScore: post.netScore,
        confirmations: post.confirmations,
        disconfirmations: post.disconfirmations,
        removed: post.removed,
        // Coalesce undefined → false: tolerates upstreams that haven't
        // applied the purge migration yet.
        purged: post.purged === true,
        createdAtBlock: post.createdAtBlock,
        createdAtTimestamp: post.createdAtTimestamp,
        lastUpdatedAt: post.lastUpdatedAt,
        attackers: post.attackerLinks.map((l) => l.address.id),
        victims: post.victimLinks.map((l) => l.address.id),
      }))

      return { items, totalCount, hasMore }
    },

    proposerLeaderboard: async (
      _root: unknown,
      args: { limit: number; offset: number; orderBy: string },
    ) => {
      const { limit, offset } = args
      const orderBy: ProposerOrderBy = isProposerOrderBy(args.orderBy)
        ? args.orderBy
        : 'totalConfirmations'

      // Pull every Proposer row from every chain. Whitelister sets are
      // small (tens) so this is cheap — no per-chain pagination needed.
      const results = await Promise.allSettled(
        chains.map(async (c) => {
          const executor = makeExecutor(c.endpoint)
          const raw = await executor({
            document: parseQueryToDocument(FETCH_PROPOSERS_QUERY),
            variables: {},
            context: {},
          }) as ExecutionResult
          if (raw.errors?.length) {
            console.error(`[mesh] ${c.slug} proposers errors:`, raw.errors)
            return [] as RawProposer[]
          }
          const parsed = FetchProposersResponse.safeParse(raw.data)
          if (!parsed.success) {
            console.error(
              `[mesh] ${c.slug} proposers schema mismatch:`,
              parsed.error.flatten(),
            )
            return [] as RawProposer[]
          }
          return parsed.data.proposers
        }),
      )

      // Aggregate by lowercased address. Same EOA whitelisted on multiple
      // chains collides into one entry; sums add up.
      const merged = new Map<string, ProposerAgg>()
      for (const r of results) {
        if (r.status !== 'fulfilled') continue
        for (const row of r.value) {
          const key = row.id.toLowerCase()
          const acc = merged.get(key) ?? {
            poster: key,
            postCount: 0,
            totalConfirmations: 0n,
            totalDisconfirmations: 0n,
          }
          acc.postCount += row.postCount
          acc.totalConfirmations += BigInt(row.totalConfirmations)
          acc.totalDisconfirmations += BigInt(row.totalDisconfirmations)
          merged.set(key, acc)
        }
      }

      // Sort by chosen orderBy DESC; stable tie-break by lower address
      // ASC so paging is deterministic.
      const sorted = [...merged.values()]
      sorted.sort((a, b) => {
        let cmp = 0
        if (orderBy === 'postCount') {
          cmp = b.postCount - a.postCount
        } else if (orderBy === 'totalConfirmations') {
          if (b.totalConfirmations !== a.totalConfirmations) {
            cmp = b.totalConfirmations > a.totalConfirmations ? 1 : -1
          }
        } else {
          if (b.totalDisconfirmations !== a.totalDisconfirmations) {
            cmp = b.totalDisconfirmations > a.totalDisconfirmations ? 1 : -1
          }
        }
        if (cmp !== 0) return cmp
        return a.poster < b.poster ? -1 : a.poster > b.poster ? 1 : 0
      })

      const totalCount = sorted.length
      const slice = sorted.slice(offset, offset + limit)
      const hasMore = offset + slice.length < totalCount

      const items = slice.map((entry) => ({
        poster: entry.poster,
        postCount: entry.postCount,
        totalConfirmations: entry.totalConfirmations.toString(),
        totalDisconfirmations: entry.totalDisconfirmations.toString(),
      }))

      return { items, totalCount, hasMore }
    },
  },
})

const parseQueryToDocument = (source: string): DocumentNode => parse(source)

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const main = async () => {
  const port = Number.parseInt(process.env.PORT ?? '4350', 10)
  const chains = enabledChains()
  if (chains.length === 0) {
    throw new Error(
      'No chains enabled. Set MESH_CHAINS env (comma-separated, e.g. "anvil,sepolia,base").',
    )
  }

  console.log(`[mesh] starting; enabled chains: ${chains.map((c) => c.slug).join(', ')}`)
  for (const c of chains) {
    console.log(`[mesh]   waiting for ${c.slug} at ${c.endpoint}`)
    await waitForUpstream(c)
  }

  const subschemas = await Promise.all(chains.map(buildSubschema))
  const schema = stitchSchemas({
    subschemas,
    typeDefs: additionalTypeDefs,
    resolvers: buildAdditionalResolvers(chains),
  })

  const yoga = createYoga({
    schema,
    graphiql: {
      // First-time visitors hit /graphql in a browser and see this. The
      // default Yoga welcome buffer is all comments — pressing Run on
      // it throws "Unexpected EOF" because the parser sees no actual
      // query. Pre-fill a real, runnable cross-chain query so anyone
      // poking around can immediately see what the API returns.
      title: 'thatsRekt · GraphQL',
      defaultQuery: GRAPHIQL_DEFAULT_QUERY,
    },
    landingPage: false,
  })

  // Lightweight HTTP router. Routes served from this dispatcher (in
  // priority order):
  //   1. /post/:chain/:postId      → SSR'd OG/Twitter card HTML (see og.ts)
  //   2. /og/post/:chain/:postId   → SVG OG image for the above (og.ts)
  //   3. /sitemap-attacks.xml      → Per-post sitemap (sitemap.ts)
  //   4. everything else           → Yoga (/graphql + 404)
  //
  // We don't reach for express here — yoga is the only other handler and
  // it already understands a node http server. A 30-line dispatcher is
  // cheaper than a router dependency.
  const server = createServer(async (req, res) => {
    try {
      // URL parsing — req.url is path+query; host is irrelevant for routing.
      const url = new URL(req.url ?? '/', 'http://internal.local')

      if (isOgRoute(url.pathname)) {
        const ua = req.headers['user-agent'] ?? null
        const result = await handleOgRoute(
          url.pathname,
          Array.isArray(ua) ? ua[0] ?? null : ua,
          { chains },
        )
        if (result) {
          res.statusCode = result.status
          res.setHeader('content-type', result.contentType)
          // Short cache — post mutations (edits, confirmations) update
          // the description. 60s is a fair compromise between cardable
          // freshness and not hammering the squid on every preview.
          res.setHeader('cache-control', 'public, max-age=60')
          res.end(result.body)
          return
        }
      }

      if (isOgImageRoute(url.pathname)) {
        const result = await handleOgImageRoute(url.pathname, { chains })
        if (result) {
          res.statusCode = result.status
          res.setHeader('content-type', result.contentType)
          // Same 60s cache as the SSR HTML — counts mutate on every vote.
          res.setHeader('cache-control', 'public, max-age=60')
          res.end(result.body)
          return
        }
      }

      if (isSitemapAttacksRoute(url.pathname)) {
        const result = await handleSitemapAttacksRoute(url.pathname, { chains })
        if (result) {
          res.statusCode = result.status
          res.setHeader('content-type', result.contentType)
          // Search engines don't refetch the sitemap aggressively, but
          // there's no reason to make per-post discovery any more stale
          // than the dynamic /post/ HTML. 5 minutes balances
          // freshness vs squid load on bot bursts.
          res.setHeader('cache-control', 'public, max-age=300')
          res.end(result.body)
          return
        }
      }
    } catch (err) {
      console.error('[mesh] route handler failed:', err)
      // Fall through to Yoga (which will 404 unknown paths). Don't
      // surface internal errors to the crawler.
    }
    // Default: hand off to Yoga (it serves /graphql and 404s elsewhere).
    yoga(req, res)
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[mesh] listening on http://0.0.0.0:${port}/graphql`)
    console.log(`[mesh] og html      → http://0.0.0.0:${port}/post/:chain/:postId`)
    console.log(`[mesh] og image     → http://0.0.0.0:${port}/og/post/:chain/:postId`)
    console.log(`[mesh] sitemap      → http://0.0.0.0:${port}/sitemap-attacks.xml`)
  })
}

main().catch((err) => {
  console.error('[mesh] fatal:', err)
  process.exit(1)
})
