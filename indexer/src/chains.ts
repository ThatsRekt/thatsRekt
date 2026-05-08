/**
 * Backend chain registry — single source of truth for chain-specific
 * config used by the Subsquid processor.
 *
 * Two flavors of chain entry:
 *   - Real chains:  `sepolia` (EIP-155 11155111), `base` (8453),
 *     `optimism` (10). Use Subsquid Network archive gateways +
 *     routeme.sh RPCs.
 *   - Local Anvil forks: `anvil-eth` (chainId 31337), `anvil-base`
 *     (chainId 31338). RPC-only mode (no archive gateway). Forked
 *     against real chain state via `--fork-url`. Distinct chain ids
 *     so the indexer doesn't conflate them with their real counterparts
 *     OR with each other.
 *
 * Running both anvil forks at once is the local cross-chain testbed —
 * deploy thatsRekt to both via DeployDev (same EOA → same CREATE2
 * proxy address), index both, and the unified Mesh feed renders posts
 * from both as if they were independent chains.
 *
 * Adding a new chain:
 *   1. Add an entry to CHAINS below.
 *   2. Supply the matching env vars in .env (RPC URL, contract address,
 *      start block — names are declared in the entry).
 *   3. Mirror in mesh/src/chains.ts and frontend/src/lib/chains.ts.
 *
 * keep in sync with mesh/src/chains.ts and frontend/src/lib/chains.ts.
 */

export type ChainSlug =
  | 'anvil-eth'
  | 'anvil-base'
  | 'sepolia'
  | 'ethereum'
  | 'base'
  | 'base-sepolia'
  | 'optimism'
  | 'arbitrum'

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
  'anvil-eth': {
    chainId: 31337,
    slug: 'anvil-eth',
    name: 'Anvil — Ethereum mainnet fork',
    gateway: null,
    rpcEnvVar: 'RPC_ANVIL_ETH_HTTP',
    contractEnvVar: 'CONTRACT_ANVIL_ETH',
    startBlockEnvVar: 'START_BLOCK_ANVIL_ETH',
    finalityConfirmation: 0,
    rpcRateLimit: 50,
  },
  'anvil-base': {
    chainId: 31338,
    slug: 'anvil-base',
    name: 'Anvil — Base fork',
    gateway: null,
    rpcEnvVar: 'RPC_ANVIL_BASE_HTTP',
    contractEnvVar: 'CONTRACT_ANVIL_BASE',
    startBlockEnvVar: 'START_BLOCK_ANVIL_BASE',
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
  'base-sepolia': {
    chainId: 84532,
    slug: 'base-sepolia',
    name: 'Base Sepolia',
    gateway: 'https://v2.archive.subsquid.io/network/base-sepolia',
    rpcEnvVar: 'RPC_BASE_SEPOLIA_HTTP',
    contractEnvVar: 'CONTRACT_BASE_SEPOLIA',
    startBlockEnvVar: 'START_BLOCK_BASE_SEPOLIA',
    finalityConfirmation: 32,
    rpcRateLimit: 10,
  },
  optimism: {
    chainId: 10,
    slug: 'optimism',
    name: 'Optimism',
    gateway: 'https://v2.archive.subsquid.io/network/optimism-mainnet',
    rpcEnvVar: 'RPC_OPTIMISM_HTTP',
    contractEnvVar: 'CONTRACT_OPTIMISM',
    startBlockEnvVar: 'START_BLOCK_OPTIMISM',
    finalityConfirmation: 75,
    rpcRateLimit: 10,
  },
  ethereum: {
    chainId: 1,
    slug: 'ethereum',
    name: 'Ethereum',
    gateway: 'https://v2.archive.subsquid.io/network/ethereum-mainnet',
    rpcEnvVar: 'RPC_ETHEREUM_HTTP',
    contractEnvVar: 'CONTRACT_ETHEREUM',
    startBlockEnvVar: 'START_BLOCK_ETHEREUM',
    finalityConfirmation: 75,
    rpcRateLimit: 10,
  },
  arbitrum: {
    chainId: 42161,
    slug: 'arbitrum',
    name: 'Arbitrum One',
    gateway: 'https://v2.archive.subsquid.io/network/arbitrum-one',
    rpcEnvVar: 'RPC_ARBITRUM_HTTP',
    contractEnvVar: 'CONTRACT_ARBITRUM',
    startBlockEnvVar: 'START_BLOCK_ARBITRUM',
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
