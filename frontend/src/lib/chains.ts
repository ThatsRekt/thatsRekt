/**
 * Frontend chain registry — display + explorer config.
 *
 * keep in sync with indexer/src/chains.ts and mesh/src/chains.ts (parallel
 * registries, layer-shaped — backend has secrets the frontend must not see).
 *
 * For anvil forks the explorer points at the *forked-from* chain's
 * explorer (etherscan / basescan). The thatsRekt contract address on a
 * local anvil won't exist on the real chain, but attacker / victim
 * addresses are real and useful to inspect there.
 */

export type ChainSlug =
  | 'anvil-eth'
  | 'anvil-base'
  | 'sepolia'
  | 'base'
  | 'base-sepolia'
  | 'optimism'
  | 'ethereum'
  | 'arbitrum'
  | 'bsc'
  | 'blast'

export interface FrontendChain {
  readonly chainId: number
  readonly slug: ChainSlug
  readonly name: string
  /** Short label shown next to addresses, post cards, etc. */
  readonly badge: string
  /** Explorer URL prefix — append `/address/0x...` or `/tx/0x...` */
  readonly explorer: string
  /** True for anvil forks — explorer links show forked-chain context, not local. */
  readonly isLocalFork: boolean
  /**
   * Whether the live indexer ingests this chain. `false` for chains
   * that exist only to render archive posts (pre-platform attacks);
   * the live feed will always be empty when these are picked, but the
   * archive section can still render their entries with proper badges
   * and explorer links.
   */
  readonly liveIndexed: boolean
}

export const CHAINS: Readonly<Record<ChainSlug, FrontendChain>> = Object.freeze({
  'anvil-eth': {
    chainId: 31337,
    slug: 'anvil-eth',
    name: 'Anvil — Ethereum mainnet fork',
    badge: 'anvil-eth',
    explorer: 'https://etherscan.io',
    isLocalFork: true,
    liveIndexed: true,
  },
  'anvil-base': {
    chainId: 31338,
    slug: 'anvil-base',
    name: 'Anvil — Base fork',
    badge: 'anvil-base',
    explorer: 'https://basescan.org',
    isLocalFork: true,
    liveIndexed: true,
  },
  sepolia: {
    chainId: 11155111,
    slug: 'sepolia',
    name: 'Ethereum Sepolia',
    badge: 'sepolia',
    explorer: 'https://sepolia.etherscan.io',
    isLocalFork: false,
    liveIndexed: true,
  },
  base: {
    chainId: 8453,
    slug: 'base',
    name: 'Base',
    badge: 'base',
    explorer: 'https://basescan.org',
    isLocalFork: false,
    liveIndexed: true,
  },
  'base-sepolia': {
    chainId: 84532,
    slug: 'base-sepolia',
    name: 'Base Sepolia',
    badge: 'base-sepolia',
    explorer: 'https://sepolia.basescan.org',
    isLocalFork: false,
    liveIndexed: true,
  },
  // Optimism is temporarily archive-only while the registry redeploys with
  // the new purge-admin governance role. Slug stays in the registry so old
  // archive entries that reference `chain: 'optimism'` still resolve their
  // badge + explorer link — the live indexer just doesn't query OP anymore.
  optimism: {
    chainId: 10,
    slug: 'optimism',
    name: 'Optimism',
    badge: 'optimism',
    explorer: 'https://optimistic.etherscan.io',
    isLocalFork: false,
    liveIndexed: false,
  },
  // ---------------------------------------------------------------------------
  // Archive-only chains (`liveIndexed: false`) — exist purely so the archive
  // feed can render pre-platform attacks with correct badges and explorer
  // links. The live indexer doesn't read from these chains, so picking one
  // in the chain filter will show an empty live section. That's intended.
  // ---------------------------------------------------------------------------
  ethereum: {
    chainId: 1,
    slug: 'ethereum',
    name: 'Ethereum',
    badge: 'ethereum',
    explorer: 'https://etherscan.io',
    isLocalFork: false,
    liveIndexed: false,
  },
  arbitrum: {
    chainId: 42161,
    slug: 'arbitrum',
    name: 'Arbitrum',
    badge: 'arbitrum',
    explorer: 'https://arbiscan.io',
    isLocalFork: false,
    liveIndexed: false,
  },
  bsc: {
    chainId: 56,
    slug: 'bsc',
    name: 'BNB Smart Chain',
    badge: 'bsc',
    explorer: 'https://bscscan.com',
    isLocalFork: false,
    liveIndexed: false,
  },
  blast: {
    chainId: 81457,
    slug: 'blast',
    name: 'Blast',
    badge: 'blast',
    explorer: 'https://blastscan.io',
    isLocalFork: false,
    liveIndexed: false,
  },
})

export const getChainBySlug = (slug: string): FrontendChain | undefined =>
  (CHAINS as Record<string, FrontendChain | undefined>)[slug]

/**
 * Resolve a chain slug to its numeric chain id.
 *
 * Returns `undefined` for unknown slugs — callers must handle that case
 * (typically by skipping the chain-pinned action / read entirely).
 *
 * Used by components that only know the slug (e.g. PostDetail derives it
 * from the composite id) but need to thread `chainId` through to wagmi
 * hooks (`useReadContract`, `useWriteContract`) so reads/writes land on
 * the correct registry contract.
 */
export const chainIdFromSlug = (slug: string): number | undefined =>
  getChainBySlug(slug)?.chainId

/**
 * Local Anvil forks are useful in dev (instant, free, exposes the full
 * cross-chain story) but should never appear in a production build —
 * end users have no use for chains that don't exist outside one
 * developer's machine.
 *
 * Default behavior: hide local forks. Set `VITE_SHOW_LOCAL_FORKS=true`
 * in `.env.local` (dev only) to surface them in the chain selector,
 * contributors page, etc. The Mesh gateway still indexes them — this
 * is purely a UI gate.
 */
const SHOW_LOCAL_FORKS = import.meta.env.VITE_SHOW_LOCAL_FORKS === 'true'

/**
 * The chain set the UI exposes — filters out local forks when not in
 * dev mode. Use this for selectors, contributors lists, anywhere the
 * end user picks or sees a chain. The full `CHAINS` registry remains
 * available for resolving an arbitrary slug (e.g. a post id whose
 * chain is one we'd otherwise hide).
 */
export const visibleChains = (): readonly FrontendChain[] =>
  Object.values(CHAINS).filter((c) => SHOW_LOCAL_FORKS || !c.isLocalFork)

/**
 * Subset of `visibleChains()` whose entries are ingested by the live
 * indexer. Use this for backend queries (whitelisters, leaderboards,
 * proposer stats) — anything that fans out a per-chain GraphQL request.
 *
 * The chain selector and archive feed should still use `visibleChains()`
 * directly so users can scope to archive-only chains.
 */
export const liveIndexedChains = (): readonly FrontendChain[] =>
  visibleChains().filter((c) => c.liveIndexed)

export const explorerAddressUrl = (chain: FrontendChain, addr: string): string =>
  `${chain.explorer}/address/${addr}`

export const explorerTxUrl = (chain: FrontendChain, txHash: string): string =>
  `${chain.explorer}/tx/${txHash}`

/**
 * How many confirmations a tx needs before we tell the user it's
 * "truly confirmed". L2 rollups have effectively 1-block finality for
 * casual reads (sequencer-soft), so we don't burn the user's time.
 * Mainnet matters more — uncle-rate is non-zero and a single-block
 * confirm can still re-org. Numbers chosen are conservative defaults
 * for a non-financial UX (a hack alert isn't a $1M trade).
 */
export const requiredConfirmations = (chainId: number): number => {
  switch (chainId) {
    case 1:        return 3   // Ethereum mainnet
    case 8453:     return 1   // Base
    case 10:       return 1   // Optimism
    case 42161:    return 1   // Arbitrum
    case 137:      return 5   // Polygon (probabilistic finality)
    case 56:       return 3   // BSC
    default:       return 1
  }
}
