/**
 * useDonations — react-query hook for the donations timeline.
 *
 * Walking skeleton (slice #205): fetches newest-first donations,
 * accumulates pages via "load more". No sort controls yet (#208).
 *
 * Accumulation: each "load more" call appends the next page to the
 * existing list. The hook owns the full list so the component stays
 * a pure renderer.
 *
 * This hook does NOT use mock.module — no module-level mocking.
 * The fetchDonations() function already gates on VITE_USE_MOCK_DATA.
 */

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { fetchDonations, type Donation } from '../lib/queries'

const PAGE_SIZE = 25

export interface UseDonationsResult {
  /** All loaded donations (accumulated across pages). */
  donations: readonly Donation[]
  isLoading: boolean
  isError: boolean
  /** True when there are more rows to fetch. */
  hasMore: boolean
  /** Call to append the next page to donations[]. */
  loadMore: () => void
  isFetchingMore: boolean
}

export function useDonations(): UseDonationsResult {
  const [offset, setOffset] = useState(0)
  const [accumulated, setAccumulated] = useState<readonly Donation[]>([])
  const [isFetchingMore, setIsFetchingMore] = useState(false)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['donations', 0, PAGE_SIZE],
    queryFn: () => fetchDonations({ limit: PAGE_SIZE, offset: 0 }),
    staleTime: 5 * 60 * 1000,
  })

  // On first load, set accumulated from the query result.
  // Subsequent pages are fetched imperatively via loadMore.
  const firstPage = data ?? []
  const allDonations: readonly Donation[] =
    accumulated.length > 0 ? accumulated : firstPage

  const loadMore = async () => {
    if (isFetchingMore) return
    const nextOffset = offset + PAGE_SIZE
    setIsFetchingMore(true)
    try {
      const nextPage = await fetchDonations({ limit: PAGE_SIZE, offset: nextOffset })
      if (nextPage.length > 0) {
        const base = accumulated.length > 0 ? accumulated : firstPage
        setAccumulated([...base, ...nextPage])
        setOffset(nextOffset)
      }
    } finally {
      setIsFetchingMore(false)
    }
  }

  // hasMore heuristic: if the last page returned exactly PAGE_SIZE rows,
  // assume there may be more. Slice #208 will add a totalCount to the
  // mesh query for a precise hasMore.
  const lastPage = accumulated.length > 0
    ? accumulated.slice(-PAGE_SIZE)
    : firstPage
  const hasMore = lastPage.length === PAGE_SIZE

  return {
    donations: allDonations,
    isLoading,
    isError,
    hasMore,
    loadMore,
    isFetchingMore,
  }
}
