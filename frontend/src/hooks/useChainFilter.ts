import { useEffect, useState } from 'react'
import { CHAINS } from '../lib/chains'

const STORAGE_KEY = 'thatsrekt:chainFilter'

/**
 * Chain filter state — `null` means "all chains", otherwise a single
 * chain slug. Persisted to localStorage so the choice survives reloads.
 *
 * Stored as a string: '' for "all", a slug otherwise. We use string
 * (not JSON-encoded null) so the value is human-readable in devtools.
 */
export type ChainFilter = string | null

const ALL_SLUGS = new Set(Object.keys(CHAINS))

function readInitial(): ChainFilter {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    if (raw === '') return null
    return ALL_SLUGS.has(raw) ? raw : null
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
