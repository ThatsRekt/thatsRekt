/**
 * Backend chain registry — single source of truth for chain-specific
 * config used by the Subsquid processor.
 *
 * Adding a new chain:
 *   1. Add an entry to CHAINS below.
 *   2. Supply the matching env vars in .env (RPC URL, contract address,
 *      start block — names are declared in the entry).
 *   3. (Mesh / frontend) add a parallel entry in mesh/.meshrc.yaml and
 *      frontend/src/lib/chains.ts.
 *
 * No code changes elsewhere in the indexer should be required.
 *
 * keep in sync with frontend/src/lib/chains.ts (parallel registry,
 * frontend-shaped — only chainId + slug + display fields).
 */

export type ChainSlug = 'anvil' | 'sepolia' | 'base'

export interface ChainConfig {
  /** EIP-155 chain id. */
  readonly chainId: number
  /** Human-readable slug — used for display, env var prefixing, and Mesh keys. */
  readonly slug: ChainSlug
  /** Display name. */
  readonly name: string
  /**
   * Subsquid Network archive gateway URL. `null` for chains without an
   * archive (e.g. local Anvil) — processor falls back to RPC-only mode.
   */
  readonly gateway: string | null
  /** Env var that holds the RPC HTTP URL for this chain. */
  readonly rpcEnvVar: string
  /** Env var that holds the deployed proxy address. */
  readonly contractEnvVar: string
  /** Env var that holds the deploy block (first block to index). */
  readonly startBlockEnvVar: string
  /**
   * Number of confirmations to consider a block finalized. `0` is fine for
   * local Anvil (single-node, no reorgs); use higher values on real chains.
   */
  readonly finalityConfirmation: number
  /** Subsquid RPC rate limit (req/s). */
  readonly rpcRateLimit: number
}

export const CHAINS: Readonly<Record<ChainSlug, ChainConfig>> = Object.freeze({
  anvil: {
    chainId: 31337,
    slug: 'anvil',
    name: 'Anvil (local fork)',
    gateway: null,
    rpcEnvVar: 'RPC_ANVIL_HTTP',
    contractEnvVar: 'CONTRACT_ANVIL',
    startBlockEnvVar: 'START_BLOCK_ANVIL',
    finalityConfirmation: 0,
    rpcRateLimit: 50,
  },
  sepolia: {
    chainId: 11155111,
    slug: 'sepolia',
    name: 'Ethereum Sepolia',
    gateway: 'https://v2.archive.subsquid.io/network/ethereum-sepolia',
    rpcEnvVar: 'RPC_SEPOLIA_HTTP',
    contractEnvVar: 'CONTRACT_SEPOLIA',
    startBlockEnvVar: 'START_BLOCK_SEPOLIA',
    finalityConfirmation: 32,
    rpcRateLimit: 10,
  },
  base: {
    chainId: 8453,
    slug: 'base',
    name: 'Base',
    gateway: 'https://v2.archive.subsquid.io/network/base-mainnet',
    rpcEnvVar: 'RPC_BASE_HTTP',
    contractEnvVar: 'CONTRACT_BASE',
    startBlockEnvVar: 'START_BLOCK_BASE',
    finalityConfirmation: 75,
    rpcRateLimit: 10,
  },
})

export const CHAIN_SLUGS: readonly ChainSlug[] = Object.freeze(
  Object.keys(CHAINS) as ChainSlug[],
)

const isChainSlug = (s: string): s is ChainSlug =>
  (CHAIN_SLUGS as readonly string[]).includes(s)

/**
 * Look up a chain by slug. Throws on unknown slug — fail fast, fail loudly.
 * Never silently default; misconfigured CHAIN env should never index the
 * "wrong" chain by accident.
 */
export const getChain = (slug: string): ChainConfig => {
  if (!isChainSlug(slug)) {
    throw new Error(
      `Unknown chain slug "${slug}". Known: ${CHAIN_SLUGS.join(', ')}`,
    )
  }
  return CHAINS[slug]
}
