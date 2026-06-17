/**
 * Pure incident-grouping logic for the live feed.
 *
 * Cross-chain incidents produce N identical posts (one per chain). This
 * module groups sibling posts into IncidentGroup values so the feed can
 * render them as a single card with a per-chain consensus strip.
 *
 * Design contract:
 *  - No side effects. No imports from outside this lib directory.
 *  - Stable: calling groupIntoIncidents with the same input twice returns
 *    groups in the same order with the same keys.
 *  - Order-preserving: the resulting group list follows the first-seen
 *    position of each group's earliest member in the input array.
 *
 * Seam for the future: once an on-chain/Mesh `incidentId` is available on
 * FeedPost, `groupKey` returns it directly — one-line swap, zero UI churn.
 */

import type { ChainInfo, FeedPost } from './queries'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IncidentGroup {
  /** groupKey result — stable identity across re-renders. */
  readonly key: string
  /**
   * All sibling posts for this incident, ordered by `attackedAt` ascending.
   * Tie-break: lowest `chainId` first.
   */
  readonly posts: readonly FeedPost[]
  /**
   * The canonical post — earliest `attackedAt`, tie-break lowest `chainId`.
   * Drives the title, summary, and guardian attribution.
   */
  readonly leadPost: FeedPost
  /**
   * Ordered chain list (same order as `posts`).
   * Undefined chain entries (legacy posts without chain metadata) are omitted.
   */
  readonly chains: readonly ChainInfo[]
  /** True when the group contains more than one post (multi-chain incident). */
  readonly isCrossChain: boolean
}

// ---------------------------------------------------------------------------
// Bucket window
// ---------------------------------------------------------------------------

/** Default coarse window for grouping contemporaneous posts. Exported so
 *  tests can assert the value and callers can tune it via `groupKeyWithWindow`. */
export const BUCKET_WINDOW_MS = 48 * 3_600_000 // 48 hours

// ---------------------------------------------------------------------------
// Chain-token patterns used by normalizeTitle and stripChainSuffix
// ---------------------------------------------------------------------------

/**
 * Tokens that can appear inside a trailing "chain" parenthetical.
 * Case-insensitive. Separators are whitespace, `+`, `/`, or `-`.
 * We deliberately keep this list broad because unknown chain names inside
 * a trailing paren are better stripped than left as visual noise.
 *
 * Rationale: the DAMM detector author controls the title format; these
 * suffixes are added programmatically ("Hack (BSC + ETH)"), not by hand.
 */
const CHAIN_SUFFIX_REGEX = /\s*\(\s*[a-z0-9\s+/,.-]+\s*\)\s*$/i

/**
 * Tokens that are clearly NOT chain identifiers — if a paren contains one
 * of these words we treat the parenthetical as meaningful and leave it.
 */
const NON_CHAIN_WORDS =
  /\b(via|with|using|through|price|manipulation|reentrancy|exploit|attack|flash|loan|oracle|bug|overflow|drainer|missing|access|control)\b/i

// ---------------------------------------------------------------------------
// Internal helper — shared by normalizeTitle and stripChainSuffix
// ---------------------------------------------------------------------------

/**
 * If `title` has a trailing parenthetical that contains ONLY chain-name
 * tokens, return the title without that suffix (trimmed). Otherwise return
 * `null`, meaning "nothing to strip".
 *
 * This is the single authoritative implementation of "is this paren
 * chain-only?" so `normalizeTitle` (grouping) and `stripChainSuffix`
 * (display) stay in sync without drift.
 */
function removeChainSuffix(title: string): string | null {
  const trimmed = title.trim()
  const match = trimmed.match(CHAIN_SUFFIX_REGEX)
  if (!match) return null

  // Paren contains real English — treat as content, not a chain label.
  if (NON_CHAIN_WORDS.test(match[0])) return null

  const withoutSuffix = trimmed.slice(0, trimmed.length - match[0].length).trim()
  // Reject degenerate case where the entire title is the paren.
  if (withoutSuffix.length === 0) return null

  return withoutSuffix
}

// ---------------------------------------------------------------------------
// Public pure functions
// ---------------------------------------------------------------------------

/**
 * Normalize a post title for **grouping** (groupKey).
 *
 * 1. Trim whitespace.
 * 2. Lowercase.
 * 3. Strip a trailing parenthetical that contains ONLY chain-name tokens
 *    (e.g. "(BSC + ETH)", "(base)") — these are conveyable via the badge
 *    cluster and clutter the headline.
 *
 * A parenthetical that contains real content (e.g. "(via reentrancy)") is
 * left intact.
 *
 * Do NOT use this for display — it lowercases the title. Use
 * `stripChainSuffix` instead.
 */
export function normalizeTitle(title: string): string {
  const stripped = removeChainSuffix(title)
  return stripped !== null ? stripped.toLowerCase() : title.trim().toLowerCase()
}

/**
 * Strip a trailing chain-only parenthetical from a post title for
 * **display** — preserving the original on-chain casing verbatim.
 *
 * Examples:
 *   "MILC/MLT Cross-Chain Bridge Attack (BSC + ETH)" → "MILC/MLT Cross-Chain Bridge Attack"
 *   "bZx iToken Duplication (ETH)"                   → "bZx iToken Duplication"
 *   "USDC Depeg Exploit"                             → "USDC Depeg Exploit"
 *   "Hack (via reentrancy)"                          → "Hack (via reentrancy)"  (unchanged)
 *
 * Never lowercases. Only strips the trailing paren when it is chain-only.
 */
export function stripChainSuffix(title: string): string {
  const stripped = removeChainSuffix(title)
  return stripped !== null ? stripped : title.trim()
}

/**
 * Coerce an ISO `attackedAt` timestamp into a coarse bucket string.
 *
 * Posts within the same 48h window produce the same bucket, allowing
 * contemporaneous cross-chain posts to share a groupKey even if the exact
 * timestamps differ by minutes.
 */
export function attackedAtBucket(
  attackedAt: string,
  windowMs: number = BUCKET_WINDOW_MS,
): string {
  const ms = new Date(attackedAt).getTime()
  if (Number.isNaN(ms)) return attackedAt // defensive: unparseable → treat as literal
  return String(Math.floor(ms / windowMs))
}

/**
 * Derive a stable group key for a post.
 *
 * Prefers `post.incidentId` when present (future on-chain formalization).
 * Falls back to the heuristic: poster.id + normalized title + attackedAt bucket.
 *
 * The key is intentionally a plain concatenation: the three components are
 * highly specific (long attacker address, specific title string, coarse
 * timestamp), so cross-incident collisions in the heuristic path are
 * effectively nil without needing a separator.
 *
 * A "id:" prefix on the incidentId path and "h:" on the heuristic path
 * ensures the two namespaces never collide — a future incidentId value of
 * e.g. "poster+title+bucket" would otherwise match a heuristic key.
 */
export function groupKey(post: FeedPost): string {
  if (post.incidentId) {
    return `id:${post.incidentId}`
  }
  return `h:${post.poster.id}${normalizeTitle(post.title)}${attackedAtBucket(post.attackedAt)}`
}

/**
 * Whether a post is being disputed.
 *
 * A row is disputed when `disconfirmations > confirmations`.
 * Zero-vote case is not disputed — we're quiet until real disagreement surfaces.
 */
export function isDisputed(post: FeedPost): boolean {
  return post.disconfirmations > post.confirmations
}

/**
 * Group a flat list of posts into IncidentGroups.
 *
 * Properties:
 *  - Stable: same input → same output structure.
 *  - Order-preserving: the resulting incident list follows the first-seen
 *    position of each group's first member in the input array.
 *  - Posts within a group are ordered by `attackedAt` ascending, tie-break
 *    lowest `chainId`.
 *  - Pure: no side effects, no mutation of input.
 */
export function groupIntoIncidents(posts: readonly FeedPost[]): IncidentGroup[] {
  // Two passes:
  //   Pass 1: assign each post to a group key, preserving insertion order.
  //   Pass 2: materialise each group into an IncidentGroup.

  const keyOrder: string[] = []
  const keyToPostList = new Map<string, FeedPost[]>()

  for (const post of posts) {
    const key = groupKey(post)
    if (!keyToPostList.has(key)) {
      keyOrder.push(key)
      keyToPostList.set(key, [])
    }
    // Non-null guaranteed by the has-check + set above.
    keyToPostList.get(key)!.push(post)
  }

  return keyOrder.map((key) => {
    const rawPosts = keyToPostList.get(key)!
    const sorted = sortSiblings(rawPosts)
    const leadPost = sorted[0]
    const chains = sorted
      .map((p) => p.chain)
      .filter((c): c is ChainInfo => c !== undefined)

    return {
      key,
      posts: sorted,
      leadPost,
      chains,
      isCrossChain: sorted.length > 1,
    } satisfies IncidentGroup
  })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Sort sibling posts by attackedAt ascending, tie-break lowest chainId. */
function sortSiblings(posts: FeedPost[]): FeedPost[] {
  return posts.slice().sort((a, b) => {
    const tA = new Date(a.attackedAt).getTime()
    const tB = new Date(b.attackedAt).getTime()
    if (tA !== tB) return tA - tB
    // Tie-break: lower chainId comes first (leads).
    return (a.chain?.chainId ?? Infinity) - (b.chain?.chainId ?? Infinity)
  })
}
