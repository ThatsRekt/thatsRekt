import { useQuery } from '@tanstack/react-query'
import { request } from 'graphql-request'
import { GRAPHQL_ENDPOINT } from '../lib/client'
import { IS_MOCK_MODE } from '../lib/queries'

/**
 * Cross-chain false-positive rate: share of all-time posts the community
 * downvoted into revoked status (disconfirmations > 2), per Mesh's
 * `falsePositiveStats` field.
 *
 * Polled infrequently — this is a lifetime aggregate that moves slowly;
 * there's no need to match the feed's tighter refetch cadence.
 */
const FALSE_POSITIVE_STATS_QUERY = /* GraphQL */ `
  query FalsePositiveStats {
    falsePositiveStats {
      revokedCount
      totalCount
      ratePercent
    }
  }
`

interface FalsePositiveStatsResponse {
  falsePositiveStats: {
    revokedCount: number
    totalCount: number
    ratePercent: number
  }
}

export function useFalsePositiveRate(): {
  ratePercent: number | null
  revokedCount: number
  totalCount: number
  isLoading: boolean
} {
  const { data, isLoading } = useQuery({
    queryKey: ['falsePositiveStats'],
    queryFn: async (): Promise<FalsePositiveStatsResponse> => {
      if (IS_MOCK_MODE) {
        return { falsePositiveStats: { revokedCount: 3, totalCount: 40, ratePercent: 7.5 } }
      }
      return request<FalsePositiveStatsResponse>(GRAPHQL_ENDPOINT, FALSE_POSITIVE_STATS_QUERY)
    },
    refetchInterval: 5 * 60_000,
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  })
  const stats = data?.falsePositiveStats
  return {
    ratePercent: stats?.ratePercent ?? null,
    revokedCount: stats?.revokedCount ?? 0,
    totalCount: stats?.totalCount ?? 0,
    isLoading,
  }
}
