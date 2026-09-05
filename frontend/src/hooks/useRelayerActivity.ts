import { useQuery } from '@tanstack/react-query'
import { gqlClient } from '../lib/client'
import { IS_MOCK_MODE } from '../lib/queries'

/**
 * Per-chain proposer activity for whitelisted addresses, backing the
 * relayer status page. Public data — see `mesh/src/relayerStatus.ts` for
 * why this doesn't need gating.
 */
const RELAYER_ACTIVITY_QUERY = /* GraphQL */ `
  query RelayerActivity {
    relayerActivity {
      address
      chainSlug
      postCount
      lastActivityAt
    }
  }
`

export interface RelayerActivityRow {
  address: string
  chainSlug: string
  postCount: number
  lastActivityAt: string
}

interface RelayerActivityResponse {
  relayerActivity: RelayerActivityRow[]
}

export function useRelayerActivity(): {
  rows: RelayerActivityRow[]
  isLoading: boolean
  isError: boolean
} {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['relayerActivity'],
    queryFn: async (): Promise<RelayerActivityResponse> => {
      if (IS_MOCK_MODE) {
        return {
          relayerActivity: [
            {
              address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
              chainSlug: 'anvil-eth',
              postCount: 3,
              lastActivityAt: new Date().toISOString(),
            },
          ],
        }
      }
      return gqlClient.request<RelayerActivityResponse>(RELAYER_ACTIVITY_QUERY)
    },
    staleTime: 30_000,
  })
  return {
    rows: data?.relayerActivity ?? [],
    isLoading,
    isError,
  }
}
