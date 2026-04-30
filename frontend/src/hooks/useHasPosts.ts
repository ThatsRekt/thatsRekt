import { useQuery } from '@tanstack/react-query'
import { request } from 'graphql-request'
import { GRAPHQL_ENDPOINT } from '../lib/client'
import { IS_MOCK_MODE } from '../lib/queries'

/**
 * One-shot existence probe for the cross-chain feed.
 *
 * Asks the Mesh gateway whether *any* post exists across all enabled
 * chains. We use the same unified `posts(...)` field the feed page
 * consumes — it fans out to every squid, sort-merges results, and
 * paginates server-side — but we only request the smallest possible
 * page (one id) to keep this cheap.
 *
 * Used to gate the leaderboard's nav link + route. The contract just
 * deployed and zero posts exist yet; surfacing an empty leaderboard
 * looks broken. The moment the first post lands, the next poll cycle
 * (60s) flips this to true and the link reappears automatically.
 *
 * Mock mode short-circuits to `true` because the dummy fixtures always
 * include posts, so the leaderboard is visible during local dev.
 */
const HAS_POSTS_QUERY = /* GraphQL */ `
  query HasPosts {
    posts(limit: 1, offset: 0) {
      items {
        id
      }
    }
  }
`

interface HasPostsResponse {
  posts: {
    items: { id: string }[]
  }
}

export function useHasPosts(): { hasPosts: boolean; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['hasPosts'],
    queryFn: async (): Promise<HasPostsResponse> => {
      if (IS_MOCK_MODE) {
        return { posts: { items: [{ id: 'mock' }] } }
      }
      return request<HasPostsResponse>(GRAPHQL_ENDPOINT, HAS_POSTS_QUERY)
    },
    refetchInterval: 60_000, // re-poll every minute so the gate flips on first post
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })
  return {
    hasPosts: (data?.posts?.items?.length ?? 0) > 0,
    isLoading,
  }
}
