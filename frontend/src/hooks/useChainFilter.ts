import { useEffect, useState } from 'react'
import { visibleChains } from '../lib/chains'

const STORAGE_KEY = 'thatsrekt:chainFilter'

/**
 * Chain filter state — `null` means "all chains", otherwise a single
 * chain slug. Always defaults to "all chains" — no localStorage persistence.
 */
export type ChainFilter = string | null

export function useChainFilter(): {
  filter: ChainFilter
  setFilter: (next: ChainFilter) => void
} {
  const [filter, setFilterState] = useState<ChainFilter>(null)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, filter ?? '')
    } catch {
      // localStorage unavailable (private mode etc.) — ignore
    }
  }, [filter])

  return { filter, setFilter: setFilterState }
}
