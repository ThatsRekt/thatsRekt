import { useQuery } from '@tanstack/react-query'
import { fetchIndexerStatus, type IndexerStatus } from '../lib/queries'

/**
 * Polls the chain tip + indexer height every 15s so the live feed page
 * can show a "live / lagging / stale" indicator.
 *
 * The polling cadence is independent from the feed query: the feed is
 * only refetched on explicit user action (refresh button, page reload).
 * We poll status at a fixed 15s interval — fast enough that a stuck
 * indexer surfaces within ~30s, slow enough not to hammer the RPC.
 *
 * The `lastFetchedAt` timestamp on the returned object is the *server-side*
 * fetch time (set inside `fetchIndexerStatus`). This is what we display
 * as "checked Ns ago", so the UI doesn't drift on initial render.
 */
export function useIndexerStatus(): {
  status: IndexerStatus | undefined
  isFetching: boolean
  isError: boolean
  refetch: () => Promise<unknown>
} {
  const query = useQuery({
    queryKey: ['indexerStatus'],
    queryFn: fetchIndexerStatus,
    refetchInterval: 15_000,
    // Status data is short-lived by definition — never serve stale.
    staleTime: 0,
    // Keep the previous status visible while a refetch is in flight so
    // the dot doesn't flash gray during a normal poll cycle.
    placeholderData: (prev) => prev,
    retry: 1,
  })

  return {
    status: query.data,
    isFetching: query.isFetching,
    isError: query.isError,
    refetch: query.refetch,
  }
}
