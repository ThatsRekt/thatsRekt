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
    note: String!
    netScore: Int!
    upvotes: Int!
    downvotes: Int!
    removed: Boolean!
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

  extend type Query {
    """Chains served by this gateway."""
    chains: [ChainInfo!]!

    """Cross-chain feed page. Posts are sort-merged by createdAtTimestamp DESC across all enabled chains. Use \`offset + limit\` for pagination."""
    posts(limit: Int = 25, offset: Int = 0): UnifiedPostsPage!
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
  note: z.string(),
  netScore: z.number().int(),
  upvotes: z.number().int(),
  downvotes: z.number().int(),
  removed: z.boolean(),
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

const FETCH_POSTS_QUERY = /* GraphQL */ `
  query FetchPosts($limit: Int!) {
    posts(orderBy: createdAtBlock_DESC, limit: $limit) {
      id
      poster { id }
      attackedAt
      note
      netScore
      upvotes
      downvotes
      removed
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
// in parallel; sum is the upper bound for the unified feed.
const COUNT_POSTS_QUERY = /* GraphQL */ `
  query CountPosts {
    postsConnection(orderBy: createdAtBlock_DESC) { totalCount }
  }
`

const CountPostsResponse = z.object({
  postsConnection: z.object({ totalCount: z.number().int() }),
})

const buildAdditionalResolvers = (chains: readonly ChainEntry[]) => ({
  Query: {
    chains: () =>
      chains.map((c) => ({ chainId: c.chainId, slug: c.slug, name: c.name })),

    posts: async (_root: unknown, args: { limit: number; offset: number }) => {
      const { limit, offset } = args
      // Each chain must yield enough rows to cover (offset + limit) after
      // merge. We over-fetch (offset + limit) per chain — generous upper
      // bound. Cursor-based pagination would be tighter; deferred.
      const fetchPerChain = offset + limit
      const results = await Promise.allSettled(
        chains.map(async (c) => {
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

      // Per-chain count for totalCount + hasMore. Run in parallel with the
      // page fetches above (separate await chain — overlap is automatic
      // because we awaited results once).
      const countResults = await Promise.allSettled(
        chains.map(async (c) => {
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
        note: post.note,
        netScore: post.netScore,
        upvotes: post.upvotes,
        downvotes: post.downvotes,
        removed: post.removed,
        createdAtBlock: post.createdAtBlock,
        createdAtTimestamp: post.createdAtTimestamp,
        lastUpdatedAt: post.lastUpdatedAt,
        attackers: post.attackerLinks.map((l) => l.address.id),
        victims: post.victimLinks.map((l) => l.address.id),
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
    graphiql: true,
    landingPage: false,
  })
  const server = createServer(yoga)

  server.listen(port, '0.0.0.0', () => {
    console.log(`[mesh] listening on http://0.0.0.0:${port}/graphql`)
  })
}

main().catch((err) => {
  console.error('[mesh] fatal:', err)
  process.exit(1)
})
