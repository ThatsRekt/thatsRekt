/**
 * Tests for the contributor-label registry.
 *
 * The labels attach human-readable identities to whitelisted poster
 * addresses. These tests pin the known automated detectors and the
 * case-insensitive / unknown-address contract of the lookup.
 */
import { describe, expect, it } from 'bun:test'
import { lookupContributorGlobal, lookupContributor } from './contributors'

const DAMM_DETECTOR = '0xFe6B4dFf18D741e725c7c6922CCF69121B2fFFdb'
const JERRY_RELAYER = '0xe0396d6d738e726d39f96099b8f6a55d11184374'

describe('contributors — DAMM Capital detector', () => {
  it("labels DAMM's detector address", () => {
    const label = lookupContributorGlobal(DAMM_DETECTOR)
    expect(label?.name).toBe("DAMM Capital's Detector")
  })

  it('resolves the DAMM detector case-insensitively', () => {
    const lower = lookupContributorGlobal(DAMM_DETECTOR.toLowerCase())
    const upper = lookupContributorGlobal(DAMM_DETECTOR.toUpperCase())
    expect(lower?.name).toBe("DAMM Capital's Detector")
    expect(upper?.name).toBe("DAMM Capital's Detector")
  })

  it('also resolves via the chain-aware lookup (no per-chain override)', () => {
    const label = lookupContributor('base', DAMM_DETECTOR)
    expect(label?.name).toBe("DAMM Capital's Detector")
  })
})

describe('contributors — regression anchors', () => {
  it("still labels Jerry's detector", () => {
    expect(lookupContributorGlobal(JERRY_RELAYER)?.name).toBe(
      "JerryTheKid.eth's Detector",
    )
  })

  it('returns undefined for an unknown address', () => {
    expect(
      lookupContributorGlobal('0x1234567890abcdef1234567890abcdef12345678'),
    ).toBeUndefined()
  })
})
