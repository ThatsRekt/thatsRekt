/**
 * Relayer status resolver for the mesh gateway.
 *
 * Backs an internal-only page listing per-chain proposer activity for
 * whitelisted detector/relayer addresses (gas balance itself is read
 * client-side straight from public RPC — a wallet's native balance is
 * public chain data with or without this endpoint; gating it here would
 * be theater). What this resolver actually gates is the *convenience* of
 * seeing every detector's last-activity timestamp in one place, which is
 * new aggregate information this gateway doesn't otherwise expose.
 *
 * Gated by a shared token passed as a query argument (mirrors guardian.ts's
 * turnstileToken-as-mutation-arg pattern rather than inventing a header/
 * cookie scheme). `assertRelayerStatusTokenForProd` fails the mesh boot
 * loudly if a real token isn't configured in production, same shape as
 * `assertTurnstileSecretForProd`.
 */
import { parse } from 'graphql'
import type { ExecutionResult } from 'graphql'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

import type { ChainEntry } from './chains.js'
import type { ChainExecutorLookup } from './comments.js'

// ---------------------------------------------------------------------------
// Token config
// ---------------------------------------------------------------------------

// Well-known dev-only default so local dev / CI don't need to configure
// anything. `assertRelayerStatusTokenForProd` refuses to boot with this
// value set in production.
const DEV_DEFAULT_TOKEN = 'dev-relayer-status-token'

const configuredToken = (): string => process.env.RELAYER_STATUS_TOKEN ?? DEV_DEFAULT_TOKEN

/**
 * Fail loud before touching any infrastructure if RELAYER_STATUS_TOKEN is
 * missing or left at the dev default in production. A missing real token
 * means this endpoint's admin token check accepts the well-known dev
 * default — i.e. no gate at all.
 */
export const assertRelayerStatusTokenForProd = (
  nodeEnv: string | undefined,
  token: string | undefined,
): void => {
  if (nodeEnv !== 'production') return
  if (!token || token === DEV_DEFAULT_TOKEN) {
    throw new Error(
      '[relayerStatus] RELAYER_STATUS_TOKEN is missing or set to the dev default in ' +
        'production. Set RELAYER_STATUS_TOKEN to a real random secret before starting mesh ' +
        'in production.',
    )
  }
}

/** Constant-time compare so token checks don't leak length/prefix via timing. */
const isValidToken = (candidate: string): boolean => {
  const expected = Buffer.from(configuredToken())
  const actual = Buffer.from(candidate)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

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
    """Internal-only: per-chain proposer activity for every address with at least one post, across all enabled chains. Requires a valid \`adminToken\` (set via RELAYER_STATUS_TOKEN) — not meant for public consumption."""
    relayerActivity(adminToken: String!): [RelayerActivity!]!
  }
`

export const buildRelayerStatusResolvers = (deps: {
  chains: readonly ChainEntry[]
  getExecutor: ChainExecutorLookup
}) => ({
  Query: {
    relayerActivity: async (
      _root: unknown,
      args: { adminToken: string },
    ): Promise<RelayerActivityRow[]> => {
      if (!isValidToken(args.adminToken)) {
        throw new Error('Unauthorized')
      }

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
