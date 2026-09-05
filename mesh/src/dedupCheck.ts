/**
 * Incident dedup pre-check — Step 1 of the "protocol-level firewall"
 * discussed for reducing duplicate/false-positive posts across
 * independently-operated detectors (Otomato workflows, DAMM's
 * hack-monitor-claw/tweet-hack-filter, any future guardian).
 *
 * This module is read-only and has NO side effects — it doesn't gate,
 * block, or modify anything by itself. It exists so a detector can ask,
 * right before it hands its payload to its relayer for signing, "has
 * this already been posted about recently?" and decide for itself what
 * to do with the answer. No relayer (Jerry's Railway box, DAMM's Lambda)
 * needs to change at all — the check is called one hop upstream of them,
 * by whatever already decides a post is worth making.
 *
 * Matching is tiered by confidence, cheapest/hardest-to-fake first:
 *   1. Exact victim-contract-address match (a victim's identity doesn't
 *      change when an attacker launders funds through a mixer — this is
 *      the most durable signal).
 *   2. Exact attacker-address match (useful when it hits, but weaker —
 *      this is exactly the thing a mixer is designed to break).
 *   3. Normalized-title equality (the fallback for a fresh, pre-forensics
 *      report that has no resolved address yet — e.g. straight from a
 *      tweet). Deliberately strict equality, not fuzzy similarity: a
 *      wrong fuzzy match risks silently burying a real second incident,
 *      which is a worse failure than an occasional missed duplicate.
 *
 * There is no exploit-tx-hash field in the indexer schema to match on —
 * `Post.createdAtTxHash` is the hash of the *posting* transaction, not
 * the underlying exploit, so it's not usable here.
 *
 * Recommended rollout (see conversation): run this in "shadow mode"
 * first — call it, log what it would have decided, but keep posting
 * regardless — for a week or two before any detector actually skips a
 * broadcast based on its answer. This endpoint doesn't enforce that; the
 * caller does.
 */
import { parse } from 'graphql'
import type { ExecutionResult } from 'graphql'
import { z } from 'zod'

import type { ChainEntry } from './chains.js'
import type { ChainExecutorLookup } from './comments.js'

// ---------------------------------------------------------------------------
// Title normalization — deliberately mirrors
// frontend/src/lib/incidents.ts's normalizeTitle exactly (strip a
// trailing chain-only parenthetical, lowercase). Duplicated rather than
// imported because the frontend and mesh are separate, unlinked
// TypeScript packages with no shared-code workspace today. Keep these
// two implementations in sync by hand if either changes.
// ---------------------------------------------------------------------------

const CHAIN_SUFFIX_REGEX = /\s*\(\s*[a-z0-9\s+/,.-]+\s*\)\s*$/i
const NON_CHAIN_WORDS =
  /\b(via|with|using|through|price|manipulation|reentrancy|exploit|attack|flash|loan|oracle|bug|overflow|drainer|missing|access|control)\b/i

function removeChainSuffix(title: string): string | null {
  const trimmed = title.trim()
  const match = trimmed.match(CHAIN_SUFFIX_REGEX)
  if (!match) return null
  if (NON_CHAIN_WORDS.test(match[0])) return null
  const withoutSuffix = trimmed.slice(0, trimmed.length - match[0].length).trim()
  if (withoutSuffix.length === 0) return null
  return withoutSuffix
}

const normalizeTitle = (title: string): string => {
  const stripped = removeChainSuffix(title)
  return stripped !== null ? stripped.toLowerCase() : title.trim().toLowerCase()
}

// ---------------------------------------------------------------------------
// Upstream queries
// ---------------------------------------------------------------------------

const PostRef = z.object({
  id: z.string(),
  title: z.string(),
  createdAtTimestamp: z.string(),
})
type PostRef = z.infer<typeof PostRef>

// PostVictim / PostAttacker are their own top-level entities (Subsquid
// requires explicit junction entities for many-to-many relations), so
// they're independently queryable by address — no `_some` relation
// filter needed on Post itself.
const VICTIM_MATCH_QUERY = /* GraphQL */ `
  query VictimMatch($address: String!, $since: DateTime!) {
    postVictims(
      where: {
        address: { id_eq: $address }
        post: { purged_eq: false, removed_eq: false, createdAtTimestamp_gte: $since }
      }
      orderBy: createdAtBlock_DESC
      limit: 1
    ) {
      post { id title createdAtTimestamp }
    }
  }
`

const ATTACKER_MATCH_QUERY = /* GraphQL */ `
  query AttackerMatch($address: String!, $since: DateTime!) {
    postAttackers(
      where: {
        address: { id_eq: $address }
        post: { purged_eq: false, removed_eq: false, createdAtTimestamp_gte: $since }
      }
      orderBy: createdAtBlock_DESC
      limit: 1
    ) {
      post { id title createdAtTimestamp }
    }
  }
`

const VictimMatchResponse = z.object({
  postVictims: z.array(z.object({ post: PostRef })),
})
const AttackerMatchResponse = z.object({
  postAttackers: z.array(z.object({ post: PostRef })),
})

// Recent titles for the fallback text check. Capped at 200 per chain —
// generous relative to actual post volume (the whitelister set itself is
// only tens of addresses) while bounding worst-case query cost.
const RECENT_TITLES_QUERY = /* GraphQL */ `
  query RecentTitles($since: DateTime!) {
    posts(
      where: { purged_eq: false, removed_eq: false, createdAtTimestamp_gte: $since }
      orderBy: createdAtBlock_DESC
      limit: 200
    ) {
      id
      title
      createdAtTimestamp
    }
  }
`

const RecentTitlesResponse = z.object({
  posts: z.array(PostRef),
})

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

interface MatchHit {
  compositeId: string
  chainSlug: string
  title: string
}

const runPerChain = async <T>(
  chains: readonly ChainEntry[],
  getExecutor: ChainExecutorLookup,
  query: string,
  variables: Record<string, unknown>,
  onResult: (chain: ChainEntry, data: unknown) => T | null,
): Promise<T[]> => {
  const results = await Promise.allSettled(
    chains.map(async (c): Promise<T | null> => {
      const executor = getExecutor(c.slug)
      if (!executor) return null
      const raw = (await executor({
        document: parse(query),
        variables,
        context: {},
      })) as ExecutionResult
      if (raw.errors?.length) {
        console.error(`[mesh] ${c.slug} dedupCheck errors:`, raw.errors)
        return null
      }
      return onResult(c, raw.data)
    }),
  )
  const values: (T | null)[] = results.map((r) => (r.status === 'fulfilled' ? r.value : null))
  return values.filter((v): v is T => v !== null)
}

export interface IncidentDuplicateCheckResult {
  isDuplicate: boolean
  confidence: 'exact' | 'title' | 'none'
  matchedPostId: string | null
  matchedChainSlug: string | null
  matchedTitle: string | null
  reason: string
}

export const dedupCheckTypeDefs = /* GraphQL */ `
  """Result of a pre-publish dedup check. Purely informational — has no side effects and enforces nothing by itself; the caller decides what to do with the answer."""
  type IncidentDuplicateCheck {
    isDuplicate: Boolean!
    """One of "exact" (victim or attacker address match), "title" (normalized title equality), or "none"."""
    confidence: String!
    """Composite id of the matched post (e.g. "ethereum-48"), if any."""
    matchedPostId: ID
    matchedChainSlug: String
    matchedTitle: String
    reason: String!
  }

  extend type Query {
    """
    Read-only, no-side-effect pre-check for detectors: "has this incident
    already been posted about recently?" Checked in order: exact victim
    contract match, exact attacker address match, normalized title
    equality — all within \`windowDays\` (default 7). Intended to be run
    in shadow mode first (log the answer, keep posting regardless) before
    any detector actually skips a broadcast based on it.
    """
    incidentDuplicateCheck(
      title: String!
      victimContract: String
      attackerAddress: String
      chains: [String!]
      windowDays: Int = 7
    ): IncidentDuplicateCheck!
  }
`

export const buildDedupCheckResolvers = (deps: {
  chains: readonly ChainEntry[]
  getExecutor: ChainExecutorLookup
}) => ({
  Query: {
    incidentDuplicateCheck: async (
      _root: unknown,
      args: {
        title: string
        victimContract?: string | null
        attackerAddress?: string | null
        chains?: string[] | null
        windowDays?: number | null
      },
    ): Promise<IncidentDuplicateCheckResult> => {
      const windowDays = args.windowDays ?? 7
      const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString()
      const filterSet = args.chains?.length ? new Set(args.chains) : null
      const activeChains = filterSet
        ? deps.chains.filter((c) => filterSet.has(c.slug))
        : deps.chains

      const toHit = (chain: ChainEntry, post: PostRef): MatchHit => ({
        compositeId: `${chain.slug}-${post.id}`,
        chainSlug: chain.slug,
        title: post.title,
      })

      // Tier 1: exact victim-contract match.
      if (args.victimContract) {
        const hits = await runPerChain(
          activeChains,
          deps.getExecutor,
          VICTIM_MATCH_QUERY,
          { address: args.victimContract.toLowerCase(), since: sinceIso },
          (chain, data) => {
            const parsed = VictimMatchResponse.safeParse(data)
            if (!parsed.success || parsed.data.postVictims.length === 0) return null
            return toHit(chain, parsed.data.postVictims[0]!.post)
          },
        )
        if (hits[0]) {
          return {
            isDuplicate: true,
            confidence: 'exact',
            matchedPostId: hits[0].compositeId,
            matchedChainSlug: hits[0].chainSlug,
            matchedTitle: hits[0].title,
            reason: `victim contract ${args.victimContract} already flagged on post ${hits[0].compositeId} within the last ${windowDays}d`,
          }
        }
      }

      // Tier 2: exact attacker-address match. Weaker signal — a mixer
      // deliberately breaks this — but cheap to check and useful when it
      // does hit (e.g. two detectors independently spotting the same
      // pre-mixer drain).
      if (args.attackerAddress) {
        const hits = await runPerChain(
          activeChains,
          deps.getExecutor,
          ATTACKER_MATCH_QUERY,
          { address: args.attackerAddress.toLowerCase(), since: sinceIso },
          (chain, data) => {
            const parsed = AttackerMatchResponse.safeParse(data)
            if (!parsed.success || parsed.data.postAttackers.length === 0) return null
            return toHit(chain, parsed.data.postAttackers[0]!.post)
          },
        )
        if (hits[0]) {
          return {
            isDuplicate: true,
            confidence: 'exact',
            matchedPostId: hits[0].compositeId,
            matchedChainSlug: hits[0].chainSlug,
            matchedTitle: hits[0].title,
            reason: `attacker address ${args.attackerAddress} already flagged on post ${hits[0].compositeId} within the last ${windowDays}d`,
          }
        }
      }

      // Tier 3: normalized title equality — the pre-forensics fallback.
      // Strict equality, not fuzzy similarity: a wrong match here would
      // silently bury a real, differently-worded incident, which is
      // worse than occasionally missing a duplicate.
      const normalizedInput = normalizeTitle(args.title)
      const titleHits = await runPerChain(
        activeChains,
        deps.getExecutor,
        RECENT_TITLES_QUERY,
        { since: sinceIso },
        (chain, data) => {
          const parsed = RecentTitlesResponse.safeParse(data)
          if (!parsed.success) return null
          const match = parsed.data.posts.find((p) => normalizeTitle(p.title) === normalizedInput)
          return match ? toHit(chain, match) : null
        },
      )
      if (titleHits[0]) {
        return {
          isDuplicate: true,
          confidence: 'title',
          matchedPostId: titleHits[0].compositeId,
          matchedChainSlug: titleHits[0].chainSlug,
          matchedTitle: titleHits[0].title,
          reason: `normalized title matches post ${titleHits[0].compositeId} within the last ${windowDays}d`,
        }
      }

      return {
        isDuplicate: false,
        confidence: 'none',
        matchedPostId: null,
        matchedChainSlug: null,
        matchedTitle: null,
        reason: `no victim/attacker/title match in the last ${windowDays}d`,
      }
    },
  },
})
