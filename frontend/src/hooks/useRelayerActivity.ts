import { useQuery } from '@tanstack/react-query'
import { gqlClient } from '../lib/client'
import { IS_MOCK_MODE } from '../lib/queries'

/**
 * Internal-only: per-chain proposer activity for whitelisted addresses,
 * backing the relayer status page. Requires an admin token — Mesh's
 * `relayerActivity` resolver rejects an invalid/missing one, which
 * surfaces here as a react-query error (`isError`).
 *
 * Disabled entirely when no token is supplied yet (pre-gate state) —
 * see `RelayerStatus.tsx`'s token-entry screen.
 */
const RELAYER_ACTIVITY_QUERY = /* GraphQL */ `
  query RelayerActivity($adminToken: String!) {
    relayerActivity(adminToken: $adminToken) {
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

export function useRelayerActivity(token: string | null): {
  rows: RelayerActivityRow[]
  isLoading: boolean
  isError: boolean
} {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['relayerActivity', token],
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
      return gqlClient.request<RelayerActivityResponse>(RELAYER_ACTIVITY_QUERY, {
        adminToken: token,
      })
    },
    enabled: !!token,
    retry: false, // a bad token won't fix itself on retry
    staleTime: 30_000,
  })
  return {
    rows: data?.relayerActivity ?? [],
    isLoading: !!token && isLoading,
    isError,
  }
}
