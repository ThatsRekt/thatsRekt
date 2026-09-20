/**
 * Registry Indexer chain registry.
 *
 * A Production Chain reads historical events from its matching Portal Dataset
 * Endpoint. Local Anvil Forks and public testnets are deliberately explicit
 * RPC-only paths; they never require Portal configuration.
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
  | 'bsc'
  | 'polygon'

export type PortalDataset =
  | 'ethereum-mainnet'
  | 'base-mainnet'
  | 'arbitrum-one'
  | 'optimism-mainnet'
  | 'binance-mainnet'
  | 'polygon-mainnet'

export interface PortalSource {
  readonly kind: 'portal'
  readonly dataset: PortalDataset
}

export interface RpcSource {
  readonly kind: 'rpc'
  readonly rpcEnvVar: string
  readonly rpcRateLimit: number
}

export type ChainSource = PortalSource | RpcSource

export interface ChainConfig {
  /** EIP-155 chain id. */
  readonly chainId: number
  /** Human-readable slug — used for display, environment, and Mesh keys. */
  readonly slug: ChainSlug
  /** Display name. */
  readonly name: string
  /** Historical ingestion source selected for this chain. */
  readonly source: ChainSource
  /** Env var that holds the deployed proxy address. */
  readonly contractEnvVar: string
  /** Env var that holds the deploy block (first block to index). */
  readonly startBlockEnvVar: string
  /** Confirmation depth retained for explicit RPC-only development paths. */
  readonly finalityConfirmation: number
  /**
   * Env var holding an RPC endpoint used ONLY for post-hoc reconciliation
   * reads (`getPost`) after a `Confirmed` event — never for log ingestion.
   * Portal chains have no ingestion RPC endpoint at all (that's the point
   * of Portal — see `700780f`), so this is how reconciliation gets one.
   *
   * Optional and independently failable: unset (or unreachable at runtime)
   * means reconciliation is a no-op for that chain — drift can still occur
   * silently, but indexing itself never blocks or crashes on it. RPC-source
   * chains don't declare this; they reuse `source.rpcEnvVar` instead (see
   * `reconcileRpcEnvVarFor`) rather than requiring a redundant var.
   */
  readonly reconcileRpcEnvVar?: string
}

const rpcSource = ({
  rpcEnvVar,
  rpcRateLimit,
}: {
  readonly rpcEnvVar: string
  readonly rpcRateLimit: number
}): RpcSource => Object.freeze({
  kind: 'rpc',
  rpcEnvVar,
  rpcRateLimit,
})

const portalSource = (dataset: PortalDataset): PortalSource => Object.freeze({
  kind: 'portal',
  dataset,
})

export const CHAINS: Readonly<Record<ChainSlug, ChainConfig>> = Object.freeze({
  'anvil-eth': {
    chainId: 31337,
    slug: 'anvil-eth',
    name: 'Anvil — Ethereum mainnet fork',
    source: rpcSource({
      rpcEnvVar: 'RPC_ANVIL_ETH_HTTP',
      rpcRateLimit: 50,
    }),
    contractEnvVar: 'CONTRACT_ANVIL_ETH',
    startBlockEnvVar: 'START_BLOCK_ANVIL_ETH',
    finalityConfirmation: 0,
  },
  'anvil-base': {
    chainId: 31338,
    slug: 'anvil-base',
    name: 'Anvil — Base fork',
    source: rpcSource({
      rpcEnvVar: 'RPC_ANVIL_BASE_HTTP',
      rpcRateLimit: 50,
    }),
    contractEnvVar: 'CONTRACT_ANVIL_BASE',
    startBlockEnvVar: 'START_BLOCK_ANVIL_BASE',
    finalityConfirmation: 0,
  },
  sepolia: {
    chainId: 11155111,
    slug: 'sepolia',
    name: 'Ethereum Sepolia',
    source: rpcSource({
      rpcEnvVar: 'RPC_SEPOLIA_HTTP',
      rpcRateLimit: 10,
    }),
    contractEnvVar: 'CONTRACT_SEPOLIA',
    startBlockEnvVar: 'START_BLOCK_SEPOLIA',
    finalityConfirmation: 32,
  },
  ethereum: {
    chainId: 1,
    slug: 'ethereum',
    name: 'Ethereum',
    source: portalSource('ethereum-mainnet'),
    contractEnvVar: 'CONTRACT_ETHEREUM',
    startBlockEnvVar: 'START_BLOCK_ETHEREUM',
    finalityConfirmation: 75,
    reconcileRpcEnvVar: 'RECONCILE_RPC_ETHEREUM_HTTP',
  },
  base: {
    chainId: 8453,
    slug: 'base',
    name: 'Base',
    source: portalSource('base-mainnet'),
    contractEnvVar: 'CONTRACT_BASE',
    startBlockEnvVar: 'START_BLOCK_BASE',
    finalityConfirmation: 75,
    reconcileRpcEnvVar: 'RECONCILE_RPC_BASE_HTTP',
  },
  'base-sepolia': {
    chainId: 84532,
    slug: 'base-sepolia',
    name: 'Base Sepolia',
    source: rpcSource({
      rpcEnvVar: 'RPC_BASE_SEPOLIA_HTTP',
      rpcRateLimit: 10,
    }),
    contractEnvVar: 'CONTRACT_BASE_SEPOLIA',
    startBlockEnvVar: 'START_BLOCK_BASE_SEPOLIA',
    finalityConfirmation: 32,
  },
  optimism: {
    chainId: 10,
    slug: 'optimism',
    name: 'Optimism',
    source: portalSource('optimism-mainnet'),
    contractEnvVar: 'CONTRACT_OPTIMISM',
    startBlockEnvVar: 'START_BLOCK_OPTIMISM',
    finalityConfirmation: 75,
    reconcileRpcEnvVar: 'RECONCILE_RPC_OPTIMISM_HTTP',
  },
  arbitrum: {
    chainId: 42161,
    slug: 'arbitrum',
    name: 'Arbitrum One',
    source: portalSource('arbitrum-one'),
    contractEnvVar: 'CONTRACT_ARBITRUM',
    startBlockEnvVar: 'START_BLOCK_ARBITRUM',
    finalityConfirmation: 75,
    reconcileRpcEnvVar: 'RECONCILE_RPC_ARBITRUM_HTTP',
  },
  bsc: {
    chainId: 56,
    slug: 'bsc',
    name: 'BNB Chain',
    source: portalSource('binance-mainnet'),
    contractEnvVar: 'CONTRACT_BSC',
    startBlockEnvVar: 'START_BLOCK_BSC',
    finalityConfirmation: 15,
    reconcileRpcEnvVar: 'RECONCILE_RPC_BSC_HTTP',
  },
  polygon: {
    chainId: 137,
    slug: 'polygon',
    name: 'Polygon',
    source: portalSource('polygon-mainnet'),
    contractEnvVar: 'CONTRACT_POLYGON',
    startBlockEnvVar: 'START_BLOCK_POLYGON',
    finalityConfirmation: 100,
    reconcileRpcEnvVar: 'RECONCILE_RPC_POLYGON_HTTP',
  },
})

export const CHAIN_SLUGS: readonly ChainSlug[] = Object.freeze(
  Object.keys(CHAINS) as ChainSlug[],
)

export const PRODUCTION_CHAIN_SLUGS = Object.freeze([
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'bsc',
  'polygon',
] as const satisfies readonly ChainSlug[])

const isChainSlug = (slug: string): slug is ChainSlug =>
  (CHAIN_SLUGS as readonly string[]).includes(slug)

/**
 * The env var whose value is the RPC endpoint reconciliation should read
 * `getPost` from for this chain — `source.rpcEnvVar` for explicit RPC-only
 * chains (no need for a second endpoint), or `reconcileRpcEnvVar` for
 * Portal chains. Undefined means reconciliation has no endpoint configured
 * for this chain at all (a valid, safe state — see `reconcileRpcEnvVar`).
 */
export const reconcileRpcEnvVarFor = (chain: ChainConfig): string | undefined =>
  chain.source.kind === 'rpc' ? chain.source.rpcEnvVar : chain.reconcileRpcEnvVar

/**
 * Look up a chain by slug. Invalid configuration never silently selects
 * another chain.
 */
export const getChain = (slug: string): ChainConfig => {
  if (!isChainSlug(slug)) {
    throw new Error(
      `Unknown chain slug "${slug}". Known: ${CHAIN_SLUGS.join(', ')}`,
    )
  }
  return CHAINS[slug]
}
