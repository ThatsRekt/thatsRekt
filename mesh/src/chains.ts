/**
 * Mesh-side chain registry.
 *
 * keep in sync with indexer/src/chains.ts (parallel registry — backend
 * shape) and frontend/src/lib/chains.ts (frontend shape).
 *
 * Adding a new chain:
 *   1. Add an entry below.
 *   2. Add the matching upstream squid GraphQL service in
 *      indexer/docker-compose.yml.
 *   3. Mirror in indexer/src/chains.ts and frontend/src/lib/chains.ts.
 */

export type ChainSlug =
  | 'anvil-eth'
  | 'anvil-base'
  | 'sepolia'
  | 'base'
  | 'base-sepolia'
  | 'optimism'

export interface ChainEntry {
  /** EIP-155 chain id. Distinct values across all entries (anvil forks
   *  use 31337/31338 to avoid colliding with their forked-from chains). */
  readonly chainId: number
  /** Human-readable slug. */
  readonly slug: ChainSlug
  /** Display name. */
  readonly name: string
  /**
   * Schema prefix applied via @graphql-tools/wrap RenameRootFields and
   * RenameTypes. e.g. 'AnvilSepolia_' makes upstream `Post` →
   * `AnvilSepolia_Post` and upstream `posts(...)` →
   * `AnvilSepolia_posts(...)`. Slug-derived but title-cased and
   * underscore-suffixed; GraphQL field names can't contain hyphens.
   */
  readonly prefix: string
  /** Internal compose-network URL of this chain's squid GraphQL endpoint. */
  readonly endpoint: string
  /**
   * On-chain registry proxy address for this chain. Used as the EIP-712
   * `verifyingContract` when verifying guardian comment signatures. Only
   * defined for chains that have a deployed registry — must be kept in
   * sync with `frontend/src/lib/contracts.ts::REGISTRY_PROXIES`.
   *
   * Chains without a deployed registry (anvil forks, sepolia, optimism
   * while archived) leave this undefined and cannot accept comments.
   */
  readonly registryAddress?: `0x${string}`
}

export const CHAINS: readonly ChainEntry[] = Object.freeze([
  {
    chainId: 31337,
    slug: 'anvil-eth',
    name: 'Anvil — Ethereum mainnet fork',
    prefix: 'AnvilEth_',
    endpoint:
      process.env.GRAPHQL_ANVIL_ETH_URL ?? 'http://graphql-anvil-eth:4351/graphql',
  },
  {
    chainId: 31338,
    slug: 'anvil-base',
    name: 'Anvil — Base fork',
    prefix: 'AnvilBase_',
    endpoint:
      process.env.GRAPHQL_ANVIL_BASE_URL ?? 'http://graphql-anvil-base:4354/graphql',
  },
  {
    chainId: 11155111,
    slug: 'sepolia',
    name: 'Ethereum Sepolia',
    prefix: 'Sepolia_',
    endpoint: process.env.GRAPHQL_SEPOLIA_URL ?? 'http://graphql-sepolia:4352/graphql',
  },
  {
    chainId: 8453,
    slug: 'base',
    name: 'Base',
    prefix: 'Base_',
    endpoint: process.env.GRAPHQL_BASE_URL ?? 'http://graphql-base:4353/graphql',
    // Base mainnet — v1.1.0 fresh deploy 2026-05-02 (#106). Mirrors
    // frontend/src/lib/contracts.ts::REGISTRY_PROXIES[8453].
    registryAddress: '0x585192Be5805Dc6D2F326369E6D0F8B7E11a7974',
  },
  {
    chainId: 84532,
    slug: 'base-sepolia',
    name: 'Base Sepolia',
    prefix: 'BaseSepolia_',
    endpoint:
      process.env.GRAPHQL_BASE_SEPOLIA_URL ??
      'http://graphql-base-sepolia:4361/graphql',
    // Base Sepolia — v1.1.0 dev deploy 2026-05-02. Mirrors
    // frontend/src/lib/contracts.ts::REGISTRY_PROXIES[84532].
    registryAddress: '0x5278dD25e8551Cc98f2dC89791f5C89a9C83F695',
  },
  {
    chainId: 10,
    slug: 'optimism',
    name: 'Optimism',
    prefix: 'Optimism_',
    endpoint:
      process.env.GRAPHQL_OPTIMISM_URL ?? 'http://graphql-optimism:4355/graphql',
    // Optimism mainnet — v1.1.0 deploy 2026-05-02. Same INITIAL_WHITELISTERS
    // + role config as Base mainnet, so CREATE2 lands the proxy at the
    // identical cross-chain canonical address.
    registryAddress: '0x585192Be5805Dc6D2F326369E6D0F8B7E11a7974',
  },
])

export const ENABLED_CHAINS = new Set(
  (process.env.MESH_CHAINS ?? 'anvil-eth,anvil-base,sepolia,base,base-sepolia')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
)

export const enabledChains = (): readonly ChainEntry[] =>
  CHAINS.filter((c) => ENABLED_CHAINS.has(c.slug))
