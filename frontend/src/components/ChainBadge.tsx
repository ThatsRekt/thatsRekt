import { getChainBySlug } from '../lib/chains'

interface ChainBadgeProps {
  slug: string
  /** Compact (just the badge) vs full (badge + chain name). */
  variant?: 'compact' | 'full'
}

// Per-chain accent color. Matches rekt.news's bracket-tag aesthetic but
// each chain gets a distinct color so the cross-chain feed is readable
// at a glance.
const SLUG_STYLES: Record<string, string> = {
  'anvil-eth': 'border-blue-500 text-blue-700 bg-blue-50',
  'anvil-base': 'border-cyan-500 text-cyan-700 bg-cyan-50',
  sepolia: 'border-purple-500 text-purple-700 bg-purple-50',
  base: 'border-blue-700 text-blue-900 bg-blue-100',
  optimism: 'border-red-500 text-red-700 bg-red-50',
  // Archive-only chains (no live indexer yet — see chains.ts).
  ethereum: 'border-indigo-500 text-indigo-700 bg-indigo-50',
  arbitrum: 'border-sky-500 text-sky-700 bg-sky-50',
  bsc: 'border-yellow-500 text-yellow-700 bg-yellow-50',
  blast: 'border-lime-500 text-lime-700 bg-lime-50',
}

export function ChainBadge({ slug, variant = 'compact' }: ChainBadgeProps) {
  const chain = getChainBySlug(slug)
  const label = chain?.badge ?? slug
  const colorClass = SLUG_STYLES[slug] ?? 'border-gray-400 text-gray-700 bg-gray-50'
  const localTag = chain?.isLocalFork ? ' · local' : ''

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 border text-[11px] font-mono uppercase tracking-wide ${colorClass}`}
      title={chain?.name ?? slug}
    >
      <span className="font-bold">{label}</span>
      {variant === 'full' && chain && (
        <span className="opacity-70 normal-case lowercase">
          {' '}
          · {chain.name.toLowerCase()}
        </span>
      )}
      {variant === 'compact' && localTag && (
        <span className="opacity-60">{localTag}</span>
      )}
    </span>
  )
}
