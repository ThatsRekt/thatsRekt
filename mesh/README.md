# thatsRekt Mesh gateway

Stitches configured per-chain registry GraphQL endpoints into one unified GraphQL endpoint on port `4350`. Mesh is the public GraphQL surface; frontends and integrators do not query an individual registry indexer directly.

## Stack

- `@graphql-tools/stitch` — schema stitching from upstream introspection.
- `@graphql-tools/wrap` — `RenameTypes` + `RenameRootFields` per chain (prefix transforms).
- `graphql-yoga` — HTTP server.
- `zod` — boundary parsing of upstream responses (catches schema drift loudly).

## Schema shape

Each enabled upstream has its types and root fields renamed with a chain prefix. Supported slugs are `anvil-eth`, `anvil-base`, `sepolia`, `ethereum`, `base`, `base-sepolia`, `optimism`, `arbitrum`, `bsc`, and `polygon`; [`src/chains.ts`](./src/chains.ts) is the source of truth for each endpoint and prefix.

On top, two cross-chain queries:

```graphql
type ChainInfo {
  chainId: Int!
  slug: String!     # one supported ChainSlug, such as "ethereum", "base", or "polygon"
  name: String!
}

type UnifiedPost {
  id: ID!           # composite: "{chainSlug}-{onchainPostId}"
  chain: ChainInfo!
  poster: String!
  attackedAt: BigInt!
  netScore: Int!
  upvotes: Int!
  downvotes: Int!
  removed: Boolean!
  createdAtBlock: Int!
  lastUpdatedAt: BigInt!
}

extend type Query {
  chains: [ChainInfo!]!
  posts(limit: Int = 25): [UnifiedPost!]!
}
```

`posts(limit)` fans out to all enabled chains, parses each response through a zod schema (`FetchPostsResponse`), and sort-merges by `createdAtBlock_DESC`.

## Configuration

`MESH_CHAINS` selects the comma-separated enabled chain slugs. Each enabled slug has a matching `GRAPHQL_<CHAIN>_URL` override declared in [`src/chains.ts`](./src/chains.ts). Local defaults serve Compose development and are not a statement of the production enabled set.

## Running

```bash
pnpm install
pnpm build          # tsc → lib/
pnpm start          # node lib/server.js  (production)
pnpm dev            # tsx watch src/server.ts (dev mode)
```

## Failure isolation

The fan-out resolver uses `Promise.allSettled` and treats any chain's failure as "no posts from that chain". A killed processor or down squid degrades gracefully — the unified feed continues serving the other chains' data with a `console.error` logged.

## Why direct stitching, not the GraphQL Mesh framework?

GraphQL Mesh v1 is feature-complete but moving to maintenance mode (Hive Gateway is the new path). For the configured registry upstream set, prefix transforms, and one custom unified resolver, direct `@graphql-tools/stitch` keeps the gateway small and under local control without introducing another framework.
