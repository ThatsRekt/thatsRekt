/**
 * Unit tests for the incident dedup pre-check (`incidentDuplicateCheck`).
 *
 * Strategy: build a mock `Executor` per test that inspects the parsed
 * query's operation name (VictimMatch / AttackerMatch / RecentTitles) and
 * returns a synthesized response — same pattern as comments.test.ts's
 * whitelist/post mocks, but keyed on query shape instead of field name.
 *
 * This is deliberately exercising the resolver end-to-end (not the
 * unexported `normalizeTitle`/`runPerChain` helpers) since those aren't
 * part of the module's public surface.
 */
import { describe, expect, test } from 'bun:test'
import type { Executor } from '@graphql-tools/utils'
import type { ExecutionResult } from 'graphql'

import { buildDedupCheckResolvers } from '../src/dedupCheck.ts'
import type { ChainEntry } from '../src/chains.ts'

const CHAIN_ALPHA: ChainEntry = {
  chainId: 1,
  slug: 'ethereum',
  name: 'Ethereum',
  prefix: 'Ethereum_',
  endpoint: 'http://test/alpha',
}
const CHAIN_BETA: ChainEntry = {
  chainId: 8453,
  slug: 'base',
  name: 'Base',
  prefix: 'Base_',
  endpoint: 'http://test/beta',
}
const TEST_CHAINS: readonly ChainEntry[] = Object.freeze([CHAIN_ALPHA, CHAIN_BETA])

interface PostFixture {
  id: string
  title: string
  createdAtTimestamp: string
}

const post = (id: string, title: string): PostFixture => ({
  id,
  title,
  createdAtTimestamp: '2026-09-01T00:00:00.000Z',
})

type QueryKind = 'VictimMatch' | 'AttackerMatch' | 'RecentTitles'

const queryKindOf = (document: unknown): QueryKind => {
  const printed = JSON.stringify(document)
  if (printed.includes('VictimMatch')) return 'VictimMatch'
  if (printed.includes('AttackerMatch')) return 'AttackerMatch'
  if (printed.includes('RecentTitles')) return 'RecentTitles'
  throw new Error(`unrecognized query in dedupCheck test mock: ${printed.slice(0, 200)}`)
}

interface ChainFixture {
  victim?: PostFixture
  attacker?: PostFixture
  recentTitles?: PostFixture[]
  /** Simulate an upstream GraphQL error for every query on this chain. */
  erroring?: boolean
}

/** Records every call so tests can assert on what was actually queried. */
interface RecordedCall {
  chainSlug: string
  kind: QueryKind
  variables: Record<string, unknown>
}

const buildDeps = (fixtures: Partial<Record<string, ChainFixture>>, calls: RecordedCall[] = []) => {
  const getExecutor = (slug: string): Executor | null => {
    const fixture = fixtures[slug]
    if (fixture === undefined) return null
    const executor: Executor = (async ({ document, variables }) => {
      const kind = queryKindOf(document)
      calls.push({ chainSlug: slug, kind, variables: (variables ?? {}) as Record<string, unknown> })
      if (fixture.erroring) {
        return { errors: [{ message: 'upstream boom' }] } as unknown as ExecutionResult
      }
      if (kind === 'VictimMatch') {
        return { data: { postVictims: fixture.victim ? [{ post: fixture.victim }] : [] } }
      }
      if (kind === 'AttackerMatch') {
        return { data: { postAttackers: fixture.attacker ? [{ post: fixture.attacker }] : [] } }
      }
      return { data: { posts: fixture.recentTitles ?? [] } }
    }) as Executor
    return executor
  }
  return { chains: TEST_CHAINS, getExecutor }
}

const runCheck = (
  fixtures: Partial<Record<string, ChainFixture>>,
  args: {
    title: string
    victimContract?: string | null
    attackerAddress?: string | null
    chains?: string[] | null
    windowDays?: number | null
  },
  calls: RecordedCall[] = [],
) => {
  const resolvers = buildDedupCheckResolvers(buildDeps(fixtures, calls))
  return resolvers.Query.incidentDuplicateCheck(null, args)
}

describe('incidentDuplicateCheck — tier 1: victim contract', () => {
  test('reports a duplicate on an exact victim-contract match', async () => {
    const out = await runCheck(
      { ethereum: { victim: post('42', 'TectonicFi Hacked') } },
      { title: 'TectonicFi Hacked', victimContract: '0xVictim' },
    )
    expect(out).toMatchObject({
      isDuplicate: true,
      confidence: 'exact',
      matchedPostId: 'ethereum-42',
      matchedChainSlug: 'ethereum',
      matchedTitle: 'TectonicFi Hacked',
    })
  })

  test('victim match short-circuits before checking attacker or title', async () => {
    const calls: RecordedCall[] = []
    const out = await runCheck(
      {
        ethereum: {
          victim: post('42', 'TectonicFi Hacked'),
          attacker: post('99', 'Some Other Post'),
        },
      },
      { title: 'Unrelated Title', victimContract: '0xVictim', attackerAddress: '0xAttacker' },
      calls,
    )
    expect(out.matchedPostId).toBe('ethereum-42')
    expect(calls.some((c) => c.kind === 'AttackerMatch')).toBe(false)
    expect(calls.some((c) => c.kind === 'RecentTitles')).toBe(false)
  })
})

describe('incidentDuplicateCheck — tier 2: attacker address', () => {
  test('falls through to attacker match when victim misses', async () => {
    const out = await runCheck(
      { ethereum: { attacker: post('7', 'Drainer Strikes Again') } },
      { title: 'Drainer Strikes Again', victimContract: '0xNoMatch', attackerAddress: '0xAttacker' },
    )
    expect(out).toMatchObject({
      isDuplicate: true,
      confidence: 'exact',
      matchedPostId: 'ethereum-7',
    })
  })
})

describe('incidentDuplicateCheck — tier 3: normalized title', () => {
  test('matches after stripping a trailing chain-only parenthetical', async () => {
    const out = await runCheck(
      { ethereum: { recentTitles: [post('3', 'Foo Protocol Hacked (Ethereum)')] } },
      { title: 'foo protocol hacked' },
    )
    expect(out).toMatchObject({
      isDuplicate: true,
      confidence: 'title',
      matchedPostId: 'ethereum-3',
    })
  })

  test('does not strip a parenthetical containing non-chain words', async () => {
    const out = await runCheck(
      { ethereum: { recentTitles: [post('3', 'Foo Protocol Hacked (Flash Loan Exploit)')] } },
      { title: 'foo protocol hacked' },
    )
    expect(out.isDuplicate).toBe(false)
  })

  test('title match is case-insensitive', async () => {
    const out = await runCheck(
      { ethereum: { recentTitles: [post('3', 'FOO PROTOCOL HACKED')] } },
      { title: 'foo protocol hacked' },
    )
    expect(out.matchedPostId).toBe('ethereum-3')
  })

  test('no match anywhere returns isDuplicate: false, confidence: none', async () => {
    const out = await runCheck({ ethereum: {} }, { title: 'Something New' })
    expect(out).toMatchObject({
      isDuplicate: false,
      confidence: 'none',
      matchedPostId: null,
      matchedChainSlug: null,
      matchedTitle: null,
    })
  })
})

describe('incidentDuplicateCheck — chain filtering', () => {
  test('chains arg restricts which chains are queried', async () => {
    const calls: RecordedCall[] = []
    const out = await runCheck(
      {
        ethereum: { attacker: post('1', 'Would Have Matched') },
        base: {},
      },
      { title: 'Something New', attackerAddress: '0xAttacker', chains: ['base'] },
      calls,
    )
    expect(out.isDuplicate).toBe(false)
    expect(calls.every((c) => c.chainSlug === 'base')).toBe(true)
  })
})

describe('incidentDuplicateCheck — resilience', () => {
  test('an erroring chain is treated as no match, not a thrown error', async () => {
    const out = await runCheck(
      { ethereum: { erroring: true }, base: { attacker: post('5', 'Still Found Me') } },
      { title: 'Still Found Me', attackerAddress: '0xAttacker' },
    )
    expect(out).toMatchObject({ isDuplicate: true, matchedPostId: 'base-5' })
  })

  test('a chain with no registered executor is skipped, not thrown', async () => {
    // CHAIN_BETA ('base') has no fixture entry at all -> getExecutor returns null.
    const out = await runCheck(
      { ethereum: { attacker: post('5', 'Still Found Me') } },
      { title: 'Still Found Me', attackerAddress: '0xAttacker' },
    )
    expect(out).toMatchObject({ isDuplicate: true, matchedPostId: 'ethereum-5' })
  })
})

describe('incidentDuplicateCheck — windowDays', () => {
  test('defaults to a 7-day window when omitted', async () => {
    const calls: RecordedCall[] = []
    await runCheck({ ethereum: {} }, { title: 'Something New' }, calls)
    const since = new Date(calls[0]!.variables['since'] as string).getTime()
    const expected = Date.now() - 7 * 86_400_000
    expect(Math.abs(since - expected)).toBeLessThan(5_000)
  })

  test('honors an explicit windowDays', async () => {
    const calls: RecordedCall[] = []
    await runCheck({ ethereum: {} }, { title: 'Something New', windowDays: 1 }, calls)
    const since = new Date(calls[0]!.variables['since'] as string).getTime()
    const expected = Date.now() - 1 * 86_400_000
    expect(Math.abs(since - expected)).toBeLessThan(5_000)
  })
})
