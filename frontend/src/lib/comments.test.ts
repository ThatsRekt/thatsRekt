import { describe, expect, it } from 'bun:test'
import { buildCreateTypedData } from './comments'
import { REGISTRY_PROXIES, chainsWithRegistry } from './contracts'
import { CHAINS } from './chains'

/**
 * Comment signing derives its EIP-712 domain from the post's composite id
 * (`{slug}-{onchainId}`) via an internal `chainSlugFromPostId` parser backed
 * by `KNOWN_SLUGS`. That slug list is a chain-list that historically drifted
 * out of sync with the registry — it left Polygon comments throwing
 * `cannot derive chain slug` even though the Polygon registry was live.
 *
 * These tests pin the comment path for the newly-wired chains AND guard the
 * drift class: every chain with a deployed registry must be parseable by the
 * comment domain builder.
 */
describe('comment EIP-712 domain', () => {
  it('resolves the BSC domain from a bsc-prefixed postId', () => {
    const td = buildCreateTypedData('bsc-1', 'gm', '2026-06-04T00:00:00Z')
    expect(td.domain.chainId).toBe(56)
    expect(td.domain.verifyingContract).toBe(REGISTRY_PROXIES[56])
  })

  it('resolves the Polygon domain from a polygon-prefixed postId', () => {
    const td = buildCreateTypedData('polygon-1', 'gm', '2026-06-04T00:00:00Z')
    expect(td.domain.chainId).toBe(137)
    expect(td.domain.verifyingContract).toBe(REGISTRY_PROXIES[137])
  })

  it('builds a comment domain for EVERY chain with a deployed registry (no drift)', () => {
    // For each registry chain, a `{slug}-1` postId must parse to that chain's
    // id + proxy. This fails loudly if a future chain is added to the registry
    // but its slug is missing from the comment parser.
    for (const chainId of chainsWithRegistry()) {
      const slug = Object.values(CHAINS).find((c) => c.chainId === chainId)?.slug
      expect(slug).toBeDefined()
      const td = buildCreateTypedData(`${slug}-1`, 'x', '2026-06-04T00:00:00Z')
      expect(td.domain.chainId).toBe(chainId)
      expect(td.domain.verifyingContract).toBe(
        (REGISTRY_PROXIES as Record<number, `0x${string}`>)[chainId],
      )
    }
  })
})
