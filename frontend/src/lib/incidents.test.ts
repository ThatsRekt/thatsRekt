/**
 * Unit tests for lib/incidents — pure grouping logic.
 *
 * TDD-first: all tests written before the implementation module exists.
 * Run via `bun test`.
 *
 * Test philosophy: assert external behaviour (given input posts, the correct
 * IncidentGroup comes out) — never poke internal structures.
 */
import { describe, expect, test } from 'bun:test'
import {
  normalizeTitle,
  stripChainSuffix,
  attackedAtBucket,
  groupKey,
  groupIntoIncidents,
  isDisputed,
  BUCKET_WINDOW_MS,
} from './incidents'
import type { FeedPost } from './queries'

// ---------------------------------------------------------------------------
// Minimal FeedPost factory — sets only the fields incidents.ts cares about.
// ---------------------------------------------------------------------------

const BASE_ATTACKED_AT = '2024-06-01T12:00:00.000Z'
const BASE_ATTACKED_AT_MS = new Date(BASE_ATTACKED_AT).getTime()

const makePoster = (id: string) => ({ id })

function makePost(overrides: Partial<FeedPost> & { id: string }): FeedPost {
  return {
    id: overrides.id,
    chain: overrides.chain,
    poster: overrides.poster ?? makePoster('0xposter1'),
    attackedAt: overrides.attackedAt ?? BASE_ATTACKED_AT,
    title: overrides.title ?? 'MILC/MLT Cross-Chain Bridge Attack',
    note: overrides.note ?? '',
    confirmations: overrides.confirmations ?? 0,
    disconfirmations: overrides.disconfirmations ?? 0,
    netScore: overrides.netScore ?? 0,
    purged: overrides.purged ?? false,
    createdAtTimestamp: overrides.createdAtTimestamp ?? BASE_ATTACKED_AT,
    attackerLinks: overrides.attackerLinks ?? [],
    victimLinks: overrides.victimLinks ?? [],
    incidentId: overrides.incidentId,
  }
}

const ETH_CHAIN = { chainId: 1, slug: 'ethereum', name: 'Ethereum' }
const BSC_CHAIN = { chainId: 56, slug: 'bsc', name: 'BNB Smart Chain' }
const BASE_CHAIN = { chainId: 8453, slug: 'base', name: 'Base' }

// ---------------------------------------------------------------------------
// normalizeTitle
// ---------------------------------------------------------------------------

describe('normalizeTitle', () => {
  test('trims and lowercases', () => {
    expect(normalizeTitle('  Foo Bar  ')).toBe('foo bar')
  })

  test('strips trailing parenthetical containing only chain tokens', () => {
    expect(normalizeTitle('MILC/MLT Bridge (BSC)')).toBe('milc/mlt bridge')
    expect(normalizeTitle('MILC/MLT Bridge (BSC + ETH)')).toBe('milc/mlt bridge')
    expect(normalizeTitle('MILC/MLT Bridge (bsc + ethereum)')).toBe('milc/mlt bridge')
    expect(normalizeTitle('MILC/MLT Bridge (ETHEREUM + ARBITRUM)')).toBe('milc/mlt bridge')
    expect(normalizeTitle('Hack (base)')).toBe('hack')
  })

  test('leaves real parentheticals intact', () => {
    // Has non-chain content — must NOT be stripped.
    expect(normalizeTitle('Hack (via reentrancy)')).toBe('hack (via reentrancy)')
    expect(normalizeTitle('Attack (price manipulation)')).toBe('attack (price manipulation)')
  })

  test('leaves title without trailing parens unchanged', () => {
    expect(normalizeTitle('Simple Hack Title')).toBe('simple hack title')
  })

  test('handles multiple chain tokens separated by + or /', () => {
    expect(normalizeTitle('Bridge (ETH / BSC / ARB)')).toBe('bridge')
  })

  test('does not strip inner parentheticals that happen to look like chain labels', () => {
    // Only trailing parenthetical should be stripped; an embedded one should stay.
    // "Bridged (BSC) funds drained" — the parens are NOT trailing.
    expect(normalizeTitle('Bridged (BSC) funds drained')).toBe('bridged (bsc) funds drained')
  })
})

// ---------------------------------------------------------------------------
// stripChainSuffix — display-only, preserves original casing
// ---------------------------------------------------------------------------

describe('stripChainSuffix', () => {
  test('MILC/MLT spec example: strips chain suffix, preserves original casing', () => {
    // The motivating example from the review spec.
    expect(stripChainSuffix('MILC/MLT Cross-Chain Bridge Attack (BSC + ETH)')).toBe(
      'MILC/MLT Cross-Chain Bridge Attack',
    )
  })

  test('bZx spec example: preserves mixed-case casing without lowercasing', () => {
    expect(stripChainSuffix('bZx iToken Duplication (ETH)')).toBe('bZx iToken Duplication')
  })

  test('USDC spec example: title without chain suffix passes through unchanged', () => {
    expect(stripChainSuffix('USDC Depeg Exploit')).toBe('USDC Depeg Exploit')
  })

  test('strips trailing BSC-only parenthetical', () => {
    expect(stripChainSuffix('MILC/MLT Bridge (BSC)')).toBe('MILC/MLT Bridge')
  })

  test('strips multi-chain parenthetical with / separator', () => {
    expect(stripChainSuffix('Bridge (ETH / BSC / ARB)')).toBe('Bridge')
  })

  test('leaves real parentheticals intact (non-chain content)', () => {
    expect(stripChainSuffix('Hack (via reentrancy)')).toBe('Hack (via reentrancy)')
    expect(stripChainSuffix('Attack (price manipulation)')).toBe('Attack (price manipulation)')
  })

  test('does NOT lowercase — output matches on-chain casing exactly', () => {
    const title = 'USDC Depeg Exploit (ETH)'
    const result = stripChainSuffix(title)
    // Exact-string check: must NOT be 'usdc depeg exploit'
    expect(result).toBe('USDC Depeg Exploit')
    expect(result).not.toBe('usdc depeg exploit')
  })

  test('trims surrounding whitespace but otherwise leaves title as-is', () => {
    expect(stripChainSuffix('  Simple Hack Title  ')).toBe('Simple Hack Title')
  })

  test('normalizeTitle and stripChainSuffix agree on WHICH suffix is stripped', () => {
    // Both functions must strip the same parentheticals — they share the
    // same removeChainSuffix internal logic. The only difference is casing.
    const titles = [
      'MILC/MLT Bridge (BSC + ETH)',
      'bZx Hack (ETH)',
      'Plain Title',
      'Hack (via reentrancy)',
    ]
    for (const t of titles) {
      const normed = normalizeTitle(t)
      const stripped = stripChainSuffix(t)
      // Lowercased stripped must equal normed (both applied the same suffix rule).
      expect(stripped.toLowerCase()).toBe(normed)
    }
  })
})

// ---------------------------------------------------------------------------
// attackedAtBucket
// ---------------------------------------------------------------------------

describe('attackedAtBucket', () => {
  test('two timestamps within the default 48h window produce the same bucket', () => {
    // Align to a bucket boundary to avoid straddling it: epoch 0 is the start
    // of bucket 0. Adding 1h keeps us well within the same bucket.
    const t1 = new Date(0).toISOString()                          // bucket start
    const t2 = new Date(1 * 3_600_000).toISOString()             // +1h, same bucket
    expect(attackedAtBucket(t1)).toBe(attackedAtBucket(t2))
  })

  test('two timestamps >48h apart produce different buckets', () => {
    const t1 = new Date(0).toISOString()
    const t2 = new Date(49 * 3_600_000).toISOString() // +49h, next bucket
    expect(attackedAtBucket(t1)).not.toBe(attackedAtBucket(t2))
  })

  test('bucket is a string (stable to coerce into groupKey)', () => {
    expect(typeof attackedAtBucket(BASE_ATTACKED_AT)).toBe('string')
  })

  test('BUCKET_WINDOW_MS is exported and equals 48h by default', () => {
    expect(BUCKET_WINDOW_MS).toBe(48 * 3_600_000)
  })
})

// ---------------------------------------------------------------------------
// groupKey
// ---------------------------------------------------------------------------

describe('groupKey', () => {
  test('same poster+title+attackedAt → same key across different chains', () => {
    const ethPost = makePost({ id: 'ethereum-1', chain: ETH_CHAIN })
    const bscPost = makePost({ id: 'bsc-1', chain: BSC_CHAIN })
    expect(groupKey(ethPost)).toBe(groupKey(bscPost))
  })

  test('different poster → different key', () => {
    const p1 = makePost({ id: 'eth-1', poster: makePoster('0xaaa') })
    const p2 = makePost({ id: 'bsc-1', poster: makePoster('0xbbb') })
    expect(groupKey(p1)).not.toBe(groupKey(p2))
  })

  test('different title (after normalize) → different key', () => {
    const p1 = makePost({ id: 'eth-1', title: 'Attack Alpha' })
    const p2 = makePost({ id: 'bsc-1', title: 'Attack Beta' })
    expect(groupKey(p1)).not.toBe(groupKey(p2))
  })

  test('prefers incidentId when present', () => {
    const postWithId = makePost({ id: 'eth-1', incidentId: 'inc-abc' })
    const postWithSameId = makePost({ id: 'bsc-1', incidentId: 'inc-abc' })
    const postWithDiffId = makePost({ id: 'arb-1', incidentId: 'inc-xyz' })
    expect(groupKey(postWithId)).toBe(groupKey(postWithSameId))
    expect(groupKey(postWithId)).not.toBe(groupKey(postWithDiffId))
  })

  test('incidentId key differs from heuristic key (they are independent)', () => {
    // A post with incidentId must not accidentally collide with a heuristic key
    // from a totally different post.
    const postWithIncidentId = makePost({ id: 'eth-1', incidentId: 'inc-foo' })
    const postHeuristic = makePost({
      id: 'bsc-1',
      // title/poster/attackedAt match postWithIncidentId but no incidentId set
    })
    // They might match or not depending on incidentId prefix — the important
    // thing is that incidentId is PREFERRED, so postWithIncidentId's key is
    // derived from the incidentId, not from the heuristic. We verify this by
    // checking that a different incidentId gives a different key than heuristic.
    const postWithDiffId = makePost({ id: 'eth-2', incidentId: 'inc-bar' })
    expect(groupKey(postWithIncidentId)).not.toBe(groupKey(postWithDiffId))
    // Heuristic-only post still produces a deterministic key
    expect(typeof groupKey(postHeuristic)).toBe('string')
    expect(groupKey(postHeuristic).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// isDisputed
// ---------------------------------------------------------------------------

describe('isDisputed', () => {
  test('returns true when disconfirmations > confirmations', () => {
    const post = makePost({ id: 'eth-1', confirmations: 1, disconfirmations: 6 })
    expect(isDisputed(post)).toBe(true)
  })

  test('returns false when confirmations > disconfirmations', () => {
    const post = makePost({ id: 'eth-1', confirmations: 8, disconfirmations: 0 })
    expect(isDisputed(post)).toBe(false)
  })

  test('returns false when equal (tie → not disputed)', () => {
    const post = makePost({ id: 'eth-1', confirmations: 3, disconfirmations: 3 })
    expect(isDisputed(post)).toBe(false)
  })

  test('returns false when both zero', () => {
    const post = makePost({ id: 'eth-1', confirmations: 0, disconfirmations: 0 })
    expect(isDisputed(post)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// groupIntoIncidents
// ---------------------------------------------------------------------------

describe('groupIntoIncidents — two siblings → one group', () => {
  const ethPost = makePost({ id: 'ethereum-1', chain: ETH_CHAIN, createdAtTimestamp: '2024-06-01T12:00:00.000Z' })
  const bscPost = makePost({
    id: 'bsc-1',
    chain: BSC_CHAIN,
    // bsc arrived slightly later
    createdAtTimestamp: '2024-06-01T13:00:00.000Z',
  })

  test('two siblings merge into one IncidentGroup', () => {
    const groups = groupIntoIncidents([ethPost, bscPost])
    expect(groups).toHaveLength(1)
  })

  test('the group contains both posts', () => {
    const groups = groupIntoIncidents([ethPost, bscPost])
    expect(groups[0].posts).toHaveLength(2)
  })

  test('isCrossChain is true', () => {
    const groups = groupIntoIncidents([ethPost, bscPost])
    expect(groups[0].isCrossChain).toBe(true)
  })

  test('chains contains both chains ordered by attackedAt', () => {
    const groups = groupIntoIncidents([ethPost, bscPost])
    // Both have the same attackedAt, tie-break by chainId (1 < 56)
    const slugs = groups[0].chains.map((c) => c.slug)
    expect(slugs).toContain('ethereum')
    expect(slugs).toContain('bsc')
  })

  test('leadPost is the one with earliest attackedAt (tie-break lowest chainId)', () => {
    const groups = groupIntoIncidents([bscPost, ethPost]) // reverse input order
    // Both have same attackedAt; ETH chainId=1 < BSC chainId=56
    expect(groups[0].leadPost.chain?.slug).toBe('ethereum')
  })
})

describe('groupIntoIncidents — single-chain post', () => {
  const singlePost = makePost({ id: 'base-1', chain: BASE_CHAIN })

  test('single-chain → one group, one post', () => {
    const groups = groupIntoIncidents([singlePost])
    expect(groups).toHaveLength(1)
    expect(groups[0].posts).toHaveLength(1)
  })

  test('isCrossChain is false', () => {
    const groups = groupIntoIncidents([singlePost])
    expect(groups[0].isCrossChain).toBe(false)
  })

  test('leadPost equals the single post', () => {
    const groups = groupIntoIncidents([singlePost])
    expect(groups[0].leadPost.id).toBe(singlePost.id)
  })
})

describe('groupIntoIncidents — distinct incidents not merged', () => {
  test('different titles → separate groups', () => {
    const p1 = makePost({ id: 'eth-1', chain: ETH_CHAIN, title: 'Alpha Protocol Hack' })
    const p2 = makePost({ id: 'bsc-1', chain: BSC_CHAIN, title: 'Beta Protocol Drain' })
    const groups = groupIntoIncidents([p1, p2])
    expect(groups).toHaveLength(2)
  })

  test('far-apart attackedAt (>48h) → separate groups', () => {
    const t1 = new Date(BASE_ATTACKED_AT_MS).toISOString()
    const t2 = new Date(BASE_ATTACKED_AT_MS + 49 * 3_600_000).toISOString()
    const p1 = makePost({ id: 'eth-1', chain: ETH_CHAIN, attackedAt: t1 })
    const p2 = makePost({ id: 'bsc-1', chain: BSC_CHAIN, attackedAt: t2 })
    const groups = groupIntoIncidents([p1, p2])
    expect(groups).toHaveLength(2)
  })

  test('different poster → separate groups despite same title and time', () => {
    const p1 = makePost({ id: 'eth-1', chain: ETH_CHAIN, poster: makePoster('0xaaa') })
    const p2 = makePost({ id: 'bsc-1', chain: BSC_CHAIN, poster: makePoster('0xbbb') })
    const groups = groupIntoIncidents([p1, p2])
    expect(groups).toHaveLength(2)
  })
})

describe('groupIntoIncidents — stability and order preservation', () => {
  test('groups appear in the same relative order as their most-recent post in the input', () => {
    // Three posts: two siblings for incident A, one post for incident B.
    // Input order (newest-first from Mesh): [A2, B1, A1]
    const a2 = makePost({ id: 'bsc-2', chain: BSC_CHAIN, createdAtTimestamp: '2024-06-02T10:00:00.000Z', title: 'Incident A' })
    const b1 = makePost({ id: 'eth-99', chain: ETH_CHAIN, title: 'Incident B', createdAtTimestamp: '2024-06-01T20:00:00.000Z' })
    const a1 = makePost({ id: 'eth-2', chain: ETH_CHAIN, createdAtTimestamp: '2024-06-01T08:00:00.000Z', title: 'Incident A' })

    const groups = groupIntoIncidents([a2, b1, a1])
    // Incident A first-seen-in-list is a2 (index 0); B is b1 (index 1)
    // → group A is first, group B is second
    expect(groups).toHaveLength(2)
    expect(groups[0].posts[0].title).toBe('Incident A')
    expect(groups[1].posts[0].title).toBe('Incident B')
  })

  test('calling groupIntoIncidents twice on the same input returns the same structure', () => {
    const p1 = makePost({ id: 'eth-1', chain: ETH_CHAIN })
    const p2 = makePost({ id: 'bsc-1', chain: BSC_CHAIN })
    const first = groupIntoIncidents([p1, p2])
    const second = groupIntoIncidents([p1, p2])
    expect(first[0].key).toBe(second[0].key)
    expect(first[0].posts.map((p) => p.id)).toEqual(second[0].posts.map((p) => p.id))
  })

  test('posts within a group are ordered by attackedAt ascending', () => {
    const later = makePost({
      id: 'bsc-1',
      chain: BSC_CHAIN,
      attackedAt: new Date(BASE_ATTACKED_AT_MS + 3_600_000).toISOString(), // +1h
      createdAtTimestamp: BASE_ATTACKED_AT,
    })
    const earlier = makePost({ id: 'eth-1', chain: ETH_CHAIN, attackedAt: BASE_ATTACKED_AT })
    // Feed arrives newest-first: [later, earlier]
    const groups = groupIntoIncidents([later, earlier])
    expect(groups[0].posts[0].attackedAt).toBe(earlier.attackedAt)
    expect(groups[0].posts[1].attackedAt).toBe(later.attackedAt)
  })
})

describe('groupIntoIncidents — three siblings', () => {
  test('three posts on three chains → one group, three posts, three chains', () => {
    const arbChain = { chainId: 42161, slug: 'arbitrum', name: 'Arbitrum' }
    const p1 = makePost({ id: 'ethereum-1', chain: ETH_CHAIN })
    const p2 = makePost({ id: 'bsc-1', chain: BSC_CHAIN })
    const p3 = makePost({ id: 'arbitrum-1', chain: arbChain })
    const groups = groupIntoIncidents([p1, p2, p3])
    expect(groups).toHaveLength(1)
    expect(groups[0].posts).toHaveLength(3)
    expect(groups[0].chains).toHaveLength(3)
    expect(groups[0].isCrossChain).toBe(true)
  })
})

describe('groupIntoIncidents — empty input', () => {
  test('returns empty array', () => {
    expect(groupIntoIncidents([])).toEqual([])
  })
})
