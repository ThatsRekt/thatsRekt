/**
 * Relayer status resolver for the mesh gateway.
 *
 * Backs an unlisted page listing per-chain proposer activity for
 * whitelisted detector/relayer addresses. Deliberately ungated: gas
 * balance is read client-side straight from public RPC (a wallet's
 * native balance is public chain data regardless), and the
 * activity/post-count data below is derived entirely from each chain's
 * own public squid (`proposers(...)`) — anyone could reconstruct it
 * themselves per-chain today. Aggregating it here is a convenience, not
 * new information, so there's nothing to gate. The page itself stays
 * unlisted (no nav link) rather than access-controlled.
 */
import { parse } from 'graphql'
import type { ExecutionResult } from 'graphql'
import { z } from 'zod'

import type { ChainEntry } from './chains.js'
import type { ChainExecutorLookup } from './comments.js'

// ---------------------------------------------------------------------------
// Upstream query
// ---------------------------------------------------------------------------

// `lastUpdatedAt` is "bumped on every counter change" per the squid schema
// doc comment — i.e. it advances on new posts BY this address AND on
// confirmations/disconfirmations RECEIVED on this address's posts. It's a
// proxy for "this address is doing something," not a strict "last posted
// at." Good enough for a v1 status page; a strict signal would need a
// dedicated Post-by-poster query per address per chain.
const FETCH_PROPOSER_ACTIVITY_QUERY = /* GraphQL */ `
  query FetchProposerActivity {
    proposers(orderBy: id_ASC) {
      id
      postCount
      lastUpdatedAt
    }
  }
`

const RawProposerActivity = z.object({
  id: z.string(),
  postCount: z.number().int(),
  lastUpdatedAt: z.string(),
})

const FetchProposerActivityResponse = z.object({
  proposers: z.array(RawProposerActivity),
})

export interface RelayerActivityRow {
  address: string
  chainSlug: string
  postCount: number
  lastActivityAt: string
}

// ---------------------------------------------------------------------------
// GraphQL bindings
// ---------------------------------------------------------------------------

export const relayerStatusTypeDefs = /* GraphQL */ `
  """Per-chain proposer activity for a whitelisted address. \`lastActivityAt\` is a proxy signal — see resolver source for exactly what bumps it."""
  type RelayerActivity {
    """Lowercased address."""
    address: String!
    chainSlug: String!
    """Lifetime post count on this chain."""
    postCount: Int!
    """Most recent bump to this address's Proposer counters on this chain (new post authored, or a confirmation/disconfirmation received)."""
    lastActivityAt: String!
  }

  extend type Query {
    """Per-chain proposer activity for every address with at least one post, across all enabled chains. Public — see resolver source for why this doesn't need gating."""
    relayerActivity: [RelayerActivity!]!
  }
`

export const buildRelayerStatusResolvers = (deps: {
  chains: readonly ChainEntry[]
  getExecutor: ChainExecutorLookup
}) => ({
  Query: {
    relayerActivity: async (): Promise<RelayerActivityRow[]> => {
      const results = await Promise.allSettled(
        deps.chains.map(async (c) => {
          const executor = deps.getExecutor(c.slug)
          if (!executor) return [] as RelayerActivityRow[]
          const raw = (await executor({
            document: parse(FETCH_PROPOSER_ACTIVITY_QUERY),
            variables: {},
            context: {},
          })) as ExecutionResult
          if (raw.errors?.length) {
            console.error(`[mesh] ${c.slug} relayerActivity errors:`, raw.errors)
            return [] as RelayerActivityRow[]
          }
          const parsed = FetchProposerActivityResponse.safeParse(raw.data)
          if (!parsed.success) {
            console.error(
              `[mesh] ${c.slug} relayerActivity schema mismatch:`,
              parsed.error.flatten(),
            )
            return [] as RelayerActivityRow[]
          }
          return parsed.data.proposers.map((p) => ({
            address: p.id,
            chainSlug: c.slug,
            postCount: p.postCount,
            lastActivityAt: p.lastUpdatedAt,
          }))
        }),
      )

      return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    },
  },
})
