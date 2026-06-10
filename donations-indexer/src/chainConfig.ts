/**
 * Per-chain processor configuration for the donations indexer.
 *
 * One process = one chain. The active chain is selected via the CHAIN_SLUG
 * env var. The processor reads the matching entry here to get:
 *   - chainId      — EIP-155 chain id
 *   - slug         — human-readable slug ('ethereum', 'base', etc.)
 *   - rpcEnvKey    — env var name for the RPC URL
 *   - startBlockEnvKey — env var name for the override start block
 *   - defaultStartBlock — pinned Safe deployment block (safe to index from)
 *   - finalityConfirmation — blocks before a block is considered final
 *
 * Safe deployment blocks are the per-chain upper-bound from the binary search
 * performed in PR #209. Each is within ~1 000 blocks of the actual creation
 * tx — a conservative start that guarantees full history without wasting time
 * scanning blocks before the Safe existed.
 *
 * Safe 0x59E4DBc95BD312A882Bb36b7f3E8298682340679 code-presence confirmed on
 * all six chains via eth_getCode (see PR body for cast commands).
 *
 * Slice #209: multi-chain rollout (Base, Arbitrum, Optimism, BSC, Polygon).
 */

export interface ChainConfig {
  /** EIP-155 chain id. */
  readonly chainId: number
  /** Human-readable slug — stored in the donation row and used as the DB
   *  cursor key. */
  readonly slug: string
  /** Env var name for the JSON-RPC URL of this chain. */
  readonly rpcEnvKey: string
  /** Env var name for the override start block (used in tests to fork from a
   *  later block). Falls back to `defaultStartBlock` when absent. */
  readonly startBlockEnvKey: string
  /** Pinned Safe deployment block derived from binary search. The processor
   *  indexes from here so the full donation history is captured without
   *  scanning pre-deploy blocks. */
  readonly defaultStartBlock: number
  /**
   * Finality confirmation depth in blocks.
   * Ethereum PoS: 75 blocks (~15 min) is safe.
   * OP-stack chains (Base, Optimism): 50 blocks (~100 s at 2 s block time).
   * Arbitrum: 100 blocks (fast blocks, ~25 s at 0.25 s avg).
   * BSC: 20 blocks (~60 s at 3 s block time).
   * Polygon: 120 blocks (~240 s at 2 s block time).
   * These are overridden by FINALITY_CONFIRMATION env var in tests.
   */
  readonly finalityConfirmation: number
}

/**
 * Registry of all supported chains, keyed by slug.
 *
 * Safe 0x59E4DBc95BD312A882Bb36b7f3E8298682340679 was confirmed deployed
 * (eth_getCode returns non-0x) on all six chains.
 *
 * Deploy block binary-search results (upper bounds, within ~1 000 blocks of
 * actual creation):
 *   ethereum  — 19 000 000 (already pinned in #205; Safe is older than the
 *                           binary search window used for L2s)
 *   base      — 45 301 000 (NOT at 45 300 000, deployed by 45 301 000)
 *   arbitrum  — 457 275 000 (NOT at 457 270 000, deployed by 457 275 000)
 *   optimism  — 150 896 000 (NOT at 150 895 000, deployed by 150 896 000)
 *   bsc       — 95 195 000 (NOT at 95 194 000, deployed by 95 195 000)
 *   polygon   — 86 136 000 (NOT at 86 135 000, deployed by 86 136 000)
 */
const CHAIN_CONFIGS: Readonly<Record<string, ChainConfig>> = Object.freeze({
  ethereum: Object.freeze({
    chainId: 1,
    slug: 'ethereum',
    rpcEnvKey: 'RPC_ETHEREUM_HTTP',
    startBlockEnvKey: 'START_BLOCK_ETHEREUM',
    defaultStartBlock: 19_000_000,
    finalityConfirmation: 75,
  }),
  base: Object.freeze({
    chainId: 8453,
    slug: 'base',
    rpcEnvKey: 'RPC_BASE_HTTP',
    startBlockEnvKey: 'START_BLOCK_BASE',
    defaultStartBlock: 45_301_000,
    finalityConfirmation: 50,
  }),
  arbitrum: Object.freeze({
    chainId: 42161,
    slug: 'arbitrum',
    rpcEnvKey: 'RPC_ARBITRUM_HTTP',
    startBlockEnvKey: 'START_BLOCK_ARBITRUM',
    defaultStartBlock: 457_275_000,
    finalityConfirmation: 100,
  }),
  optimism: Object.freeze({
    chainId: 10,
    slug: 'optimism',
    rpcEnvKey: 'RPC_OPTIMISM_HTTP',
    startBlockEnvKey: 'START_BLOCK_OPTIMISM',
    defaultStartBlock: 150_896_000,
    finalityConfirmation: 50,
  }),
  bsc: Object.freeze({
    chainId: 56,
    slug: 'bsc',
    rpcEnvKey: 'RPC_BSC_HTTP',
    startBlockEnvKey: 'START_BLOCK_BSC',
    defaultStartBlock: 95_195_000,
    finalityConfirmation: 20,
  }),
  polygon: Object.freeze({
    chainId: 137,
    slug: 'polygon',
    rpcEnvKey: 'RPC_POLYGON_HTTP',
    startBlockEnvKey: 'START_BLOCK_POLYGON',
    defaultStartBlock: 86_136_000,
    finalityConfirmation: 120,
  }),
})

/**
 * Return the chain config for the given slug, or null if unsupported.
 * Lookup is case-insensitive — slugs are normalized to lowercase.
 */
export const chainConfigFor = (slug: string): ChainConfig | null =>
  CHAIN_CONFIGS[slug.toLowerCase()] ?? null

/**
 * Return all supported chain slugs.
 */
export const supportedSlugs = (): readonly string[] => Object.keys(CHAIN_CONFIGS)
