# thatsRekt Mesh gateway

Stitches the per-chain Subsquid GraphQL endpoints (`graphql-anvil`, `graphql-sepolia`, `graphql-base`) into one unified GraphQL endpoint on port `4350`. The single public GraphQL surface — frontends and integrators talk to Mesh, never directly to a squid.

## Stack

- `@graphql-tools/stitch` — schema stitching from upstream introspection.
- `@graphql-tools/wrap` — `RenameTypes` + `RenameRootFields` per chain (prefix transforms).
- `graphql-yoga` — HTTP server.
- `zod` — boundary parsing of upstream responses (catches schema drift loudly).

## Schema shape

Per upstream squid, every type and root field is renamed with a chain prefix:

| Upstream | Mesh-side |
|---|---|
| `graphql-anvil:4351` | `Anvil_posts(...)`, `Anvil_Post`, `Anvil_addresses(...)`, ... |
| `graphql-sepolia:4352` | `Sepolia_posts(...)`, `Sepolia_Post`, ... |
| `graphql-base:4353` | `Base_posts(...)`, `Base_Post`, ... |

On top, two cross-chain queries:

```graphql
type ChainInfo {
  chainId: Int!
  slug: String!     # "anvil" | "sepolia" | "base"
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

| Env | Default | Purpose |
|---|---|---|
| `PORT` | `4350` | Mesh HTTP port |
| `MESH_CHAINS` | `anvil,sepolia,base` | Comma-separated list of chain slugs to enable |
| `GRAPHQL_ANVIL_URL` | `http://graphql-anvil:4351/graphql` | Upstream squid endpoint |
| `GRAPHQL_SEPOLIA_URL` | `http://graphql-sepolia:4352/graphql` | Upstream squid endpoint |
| `GRAPHQL_BASE_URL` | `http://graphql-base:4353/graphql` | Upstream squid endpoint |

The defaults match `indexer/docker-compose.yml` service names, so no env is required when running in compose.

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

Mesh v1 is feature-complete but moving to maintenance mode (Hive Gateway is the new path). For our use case — three GraphQL upstreams, prefix transforms, one custom unified resolver — the direct `@graphql-tools/stitch` API is ~150 lines of TypeScript with full control. No framework to learn or upgrade.
