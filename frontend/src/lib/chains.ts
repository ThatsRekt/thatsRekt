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

export interface FrontendChain {
  readonly chainId: number
  readonly slug: 'anvil-eth' | 'anvil-base' | 'sepolia' | 'base'
  readonly name: string
  /** Short label shown next to addresses, post cards, etc. */
  readonly badge: string
  /** Explorer URL prefix — append `/address/0x...` or `/tx/0x...` */
  readonly explorer: string
  /** True for anvil forks — explorer links show forked-chain context, not local. */
  readonly isLocalFork: boolean
}

export const CHAINS: Readonly<Record<FrontendChain['slug'], FrontendChain>> =
  Object.freeze({
    'anvil-eth': {
      chainId: 31337,
      slug: 'anvil-eth',
      name: 'Anvil — Ethereum mainnet fork',
      badge: 'anvil-eth',
      explorer: 'https://etherscan.io',
      isLocalFork: true,
    },
    'anvil-base': {
      chainId: 31338,
      slug: 'anvil-base',
      name: 'Anvil — Base fork',
      badge: 'anvil-base',
      explorer: 'https://basescan.org',
      isLocalFork: true,
    },
    sepolia: {
      chainId: 11155111,
      slug: 'sepolia',
      name: 'Ethereum Sepolia',
      badge: 'sepolia',
      explorer: 'https://sepolia.etherscan.io',
      isLocalFork: false,
    },
    base: {
      chainId: 8453,
      slug: 'base',
      name: 'Base',
      badge: 'base',
      explorer: 'https://basescan.org',
      isLocalFork: false,
    },
  })

export const getChainBySlug = (slug: string): FrontendChain | undefined =>
  (CHAINS as Record<string, FrontendChain | undefined>)[slug]

export const explorerAddressUrl = (chain: FrontendChain, addr: string): string =>
  `${chain.explorer}/address/${addr}`

export const explorerTxUrl = (chain: FrontendChain, txHash: string): string =>
  `${chain.explorer}/tx/${txHash}`
