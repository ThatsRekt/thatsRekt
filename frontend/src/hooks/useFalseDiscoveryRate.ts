import { useQuery } from '@tanstack/react-query'
import { request } from 'graphql-request'
import { GRAPHQL_ENDPOINT } from '../lib/client'
import { IS_MOCK_MODE } from '../lib/queries'

/**
 * Cross-chain false discovery rate (FDR): share of all-time posts the
 * community downvoted into revoked status (disconfirmations > 2), per
 * Mesh's `falseDiscoveryStats` field.
 *
 * Named FDR, not "false positive rate" — FPR needs a denominator of every
 * case where nothing happened, which this registry can't see. FDR (false
 * calls / all calls made) is exactly what's computable from post data.
 *
 * Polled infrequently — this is a lifetime aggregate that moves slowly;
 * there's no need to match the feed's tighter refetch cadence.
 */
const FALSE_DISCOVERY_STATS_QUERY = /* GraphQL */ `
  query FalseDiscoveryStats {
    falseDiscoveryStats {
      revokedCount
      totalCount
      ratePercent
    }
  }
`

interface FalseDiscoveryStatsResponse {
  falseDiscoveryStats: {
    revokedCount: number
    totalCount: number
    ratePercent: number
  }
}

export function useFalseDiscoveryRate(): {
  ratePercent: number | null
  revokedCount: number
  totalCount: number
  isLoading: boolean
} {
  const { data, isLoading } = useQuery({
    queryKey: ['falseDiscoveryStats'],
    queryFn: async (): Promise<FalseDiscoveryStatsResponse> => {
      if (IS_MOCK_MODE) {
        return { falseDiscoveryStats: { revokedCount: 3, totalCount: 40, ratePercent: 7.5 } }
      }
      return request<FalseDiscoveryStatsResponse>(GRAPHQL_ENDPOINT, FALSE_DISCOVERY_STATS_QUERY)
    },
    refetchInterval: 5 * 60_000,
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  })
  const stats = data?.falseDiscoveryStats
  return {
    ratePercent: stats?.ratePercent ?? null,
    revokedCount: stats?.revokedCount ?? 0,
    totalCount: stats?.totalCount ?? 0,
    isLoading,
  }
}
