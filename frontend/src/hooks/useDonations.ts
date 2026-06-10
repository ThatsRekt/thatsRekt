/**
 * useDonations — react-query hook for the donations timeline.
 *
 * Supports:
 *   - Server-side ordering via orderBy/direction (any of the 5 whitelisted columns).
 *   - Proper offset pagination (50/page) that accumulates pages.
 *   - Correct hasMore signal: true iff last fetched page was full (PAGE_SIZE rows).
 *   - sortState reset: when orderBy or direction changes, all accumulated pages are
 *     cleared and the dataset is re-fetched from offset 0.
 *
 * sortState ownership: the caller manages sortState (typically via sortStateReducer)
 * and passes it in. This hook is a pure data layer — no sort state inside.
 *
 * This hook does NOT use mock.module — no module-level mocking.
 * The fetchDonations() function already gates on VITE_USE_MOCK_DATA.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchDonations, type Donation } from '../lib/queries'
import type { SortState } from '../lib/sortState'

export const PAGE_SIZE = 50

export interface UseDonationsResult {
  /** All loaded donations (accumulated across pages). */
  donations: readonly Donation[]
  isLoading: boolean
  isError: boolean
  /** True when there are more rows to fetch (last page was exactly PAGE_SIZE). */
  hasMore: boolean
  /** Call to append the next page to donations[]. */
  loadMore: () => void
  isFetchingMore: boolean
}

export function useDonations(sortState: SortState): UseDonationsResult {
  const [donations, setDonations] = useState<readonly Donation[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isError, setIsError] = useState(false)
  const [isFetchingMore, setIsFetchingMore] = useState(false)
  // The offset of the NEXT page to fetch (tracks what has been loaded so far).
  const [nextOffset, setNextOffset] = useState(0)
  // The length of the last fetched page — used to compute hasMore.
  const [lastPageLen, setLastPageLen] = useState(0)

  // Ref to the current sort key so the effect can compare without being in the
  // dependency array (avoids double-fetching on mount).
  const sortKeyRef = useRef<string>('')
  const sortKey = `${sortState.orderBy}:${sortState.direction}`

  useEffect(() => {
    const sortChanged = sortKeyRef.current !== sortKey
    sortKeyRef.current = sortKey

    // Reset accumulated state when sort changes (or on first mount).
    if (sortChanged) {
      setDonations([])
      setNextOffset(0)
      setLastPageLen(0)
    }

    let cancelled = false
    setIsLoading(true)
    setIsError(false)

    fetchDonations({
      limit: PAGE_SIZE,
      offset: 0,
      orderBy: sortState.orderBy,
      direction: sortState.direction,
    })
      .then((page) => {
        if (cancelled) return
        setDonations(page)
        setNextOffset(PAGE_SIZE)
        setLastPageLen(page.length)
        setIsLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setIsError(true)
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortKey])

  const loadMore = useCallback(() => {
    if (isFetchingMore || isLoading) return
    setIsFetchingMore(true)
    fetchDonations({
      limit: PAGE_SIZE,
      offset: nextOffset,
      orderBy: sortState.orderBy,
      direction: sortState.direction,
    })
      .then((page) => {
        setDonations((prev) => [...prev, ...page])
        setNextOffset((prev) => prev + PAGE_SIZE)
        setLastPageLen(page.length)
        setIsFetchingMore(false)
      })
      .catch(() => {
        // On load-more error don't wipe the existing data; just stop.
        setIsFetchingMore(false)
      })
  }, [isFetchingMore, isLoading, nextOffset, sortState.orderBy, sortState.direction])

  // hasMore: the last fetched page was exactly PAGE_SIZE rows.
  const hasMore = lastPageLen === PAGE_SIZE

  return {
    donations,
    isLoading,
    isError,
    hasMore,
    loadMore,
    isFetchingMore,
  }
}
