import { useEffect, useState } from 'react'
import { visibleChains } from '../lib/chains'

const STORAGE_KEY = 'thatsrekt:chainFilter'

/**
 * Chain filter state — `null` means "all chains", otherwise a single
 * chain slug. Persisted to localStorage so the choice survives reloads.
 *
 * Stored as a string: '' for "all", a slug otherwise. We use string
 * (not JSON-encoded null) so the value is human-readable in devtools.
 */
export type ChainFilter = string | null

function readInitial(): ChainFilter {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    if (raw === '') return null
    // Validate against the *visible* set, not all chains. A stale
    // localStorage value for a hidden local-fork slug should reset to
    // "all" rather than silently filter to a chain the UI no longer
    // exposes.
    const visibleSlugs = new Set<string>(visibleChains().map((c) => c.slug))
    return visibleSlugs.has(raw) ? raw : null
  } catch {
    return null
  }
}

export function useChainFilter(): {
  filter: ChainFilter
  setFilter: (next: ChainFilter) => void
} {
  const [filter, setFilterState] = useState<ChainFilter>(readInitial)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, filter ?? '')
    } catch {
      // localStorage unavailable (private mode etc.) — ignore
    }
  }, [filter])

  return { filter, setFilter: setFilterState }
}
