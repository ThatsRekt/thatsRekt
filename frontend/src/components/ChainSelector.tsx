import { visibleChains } from '../lib/chains'
import type { ChainFilter } from '../hooks/useChainFilter'

interface ChainSelectorProps {
  value: ChainFilter
  onChange: (next: ChainFilter) => void
}

/**
 * Native <select> chain dropdown — accessible, mobile-friendly out of
 * the box (uses each platform's native picker), no popover positioning
 * to maintain. Sits in the feed's header strip alongside the sort tabs.
 */
export function ChainSelector({ value, onChange }: ChainSelectorProps) {
  return (
    <label className="inline-flex items-center gap-2 text-[10px] uppercase tracking-widest text-neutral-700">
      <span>chain:</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="border border-black bg-[#f5f4ee] px-2 py-0.5 text-xs font-mono uppercase tracking-widest hover:bg-yellow-100 focus:outline-none focus:ring-2 focus:ring-red-600 cursor-pointer touch-manipulation"
      >
        <option value="">all chains</option>
        {visibleChains().map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.badge}
            {c.isLocalFork ? ' · local' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
