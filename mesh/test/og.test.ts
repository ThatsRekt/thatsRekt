/**
 * Unit tests for the OG image route PNG conversion.
 *
 * Verifies that handleOgImageRoute returns image/png with valid PNG bytes
 * (PNG magic header) on all 5 exit paths:
 *   1. unknown chain → 404 fallback
 *   2. invalid post id → 404 fallback
 *   3. post not found → 404 fallback
 *   4. purged post → 200 tombstone
 *   5. live post → 200 real card
 *
 * Mock strategy: we intercept global fetch so the squid lookup is fully
 * controlled — same approach used throughout this test suite (the guardian
 * and comments tests mock at the module boundary; here the squid call is
 * an inline `fetch()` inside handleOgImageRoute, so we replace
 * `globalThis.fetch`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { handleOgImageRoute } from '../src/og.js'
import type { OgRouteDeps } from '../src/og.js'
import type { ChainEntry } from '../src/chains.js'
import { __internal } from '../src/og.js'

// ---------------------------------------------------------------------------
// PNG magic bytes: 8-byte signature that all valid PNG files start with.
// ---------------------------------------------------------------------------

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const isPngMagic = (body: string | Uint8Array): boolean => {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  if (bytes.length < 8) return false
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Test chain fixture
// ---------------------------------------------------------------------------

const TEST_CHAIN: ChainEntry = Object.freeze({
  chainId: 1,
  slug: 'ethereum',
  name: 'Ethereum',
  prefix: 'Ethereum_',
  endpoint: 'http://test-squid/graphql',
  registryAddress: '0xBfaEEE9662b4c037De24e5Caa65815350d57b89A',
})

const DEPS: OgRouteDeps = Object.freeze({ chains: [TEST_CHAIN] })
const DEPS_EMPTY: OgRouteDeps = Object.freeze({ chains: [] })

// ---------------------------------------------------------------------------
// Minimal post fixture that passes ZodSchema validation in og.ts
// ---------------------------------------------------------------------------

const LIVE_POST = {
  id: '17',
  title: 'Test Hack Title',
  note: 'Some note',
  poster: { id: '0xda1bdef0000000000000000000000000000000aa' },
  attackedAt: '2026-01-01T00:00:00.000Z',
  createdAtTimestamp: '2026-01-01T00:00:00.000Z',
  lastUpdatedAt: '2026-01-01T00:00:00.000Z',
  confirmations: 3,
  disconfirmations: 0,
  netScore: 3,
  removed: false,
  purged: false,
  attackerLinks: [{ address: { id: '0xdeadbeef00000000000000000000000000000001' } }],
  victimLinks: [{ address: { id: '0xcafe000000000000000000000000000000000001' } }],
}

const PURGED_POST = { ...LIVE_POST, purged: true }

// ---------------------------------------------------------------------------
// Global fetch mock helpers
// ---------------------------------------------------------------------------

let mockFetch: (url: string, init?: RequestInit) => Promise<Response>

const originalFetch = globalThis.fetch

beforeEach(() => {
  // Default: passthrough (should not be reached in most tests)
  mockFetch = async () => {
    throw new Error('unexpected fetch call in test')
  }
  globalThis.fetch = (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    return mockFetch(urlStr, init)
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

const stubSquidPost = (post: unknown): void => {
  mockFetch = async () =>
    new Response(JSON.stringify({ data: { postById: post } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
}

const stubSquidError = (): void => {
  mockFetch = async () => {
    throw new Error('squid unreachable')
  }
}

// ---------------------------------------------------------------------------
// Path 1: unknown chain → 404 + PNG fallback
// ---------------------------------------------------------------------------

describe('handleOgImageRoute — unknown chain', () => {
  test('returns 404', async () => {
    const result = await handleOgImageRoute('/og/post/unknown-chain/1', DEPS_EMPTY)
    expect(result).not.toBeNull()
    expect(result!.status).toBe(404)
  })

  test('content-type is image/png', async () => {
    const result = await handleOgImageRoute('/og/post/unknown-chain/1', DEPS_EMPTY)
    expect(result!.contentType).toBe('image/png')
  })

  test('body starts with PNG magic bytes', async () => {
    const result = await handleOgImageRoute('/og/post/unknown-chain/1', DEPS_EMPTY)
    expect(isPngMagic(result!.body)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Path 2: invalid post id → 404 + PNG fallback
// ---------------------------------------------------------------------------

describe('handleOgImageRoute — invalid post id', () => {
  test('returns 404', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/not-a-number', DEPS)
    expect(result!.status).toBe(404)
  })

  test('content-type is image/png', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/not-a-number', DEPS)
    expect(result!.contentType).toBe('image/png')
  })

  test('body starts with PNG magic bytes', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/not-a-number', DEPS)
    expect(isPngMagic(result!.body)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Path 3: post not found (squid returns null) → 404 + PNG fallback
// ---------------------------------------------------------------------------

describe('handleOgImageRoute — post not found', () => {
  beforeEach(() => stubSquidPost(null))

  test('returns 404', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/999', DEPS)
    expect(result!.status).toBe(404)
  })

  test('content-type is image/png', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/999', DEPS)
    expect(result!.contentType).toBe('image/png')
  })

  test('body starts with PNG magic bytes', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/999', DEPS)
    expect(isPngMagic(result!.body)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Path 3b: squid unreachable → falls through to "not found" → 404 + PNG
// ---------------------------------------------------------------------------

describe('handleOgImageRoute — squid unreachable', () => {
  beforeEach(() => stubSquidError())

  test('returns 404', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/17', DEPS)
    expect(result!.status).toBe(404)
  })

  test('content-type is image/png', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/17', DEPS)
    expect(result!.contentType).toBe('image/png')
  })

  test('body starts with PNG magic bytes', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/17', DEPS)
    expect(isPngMagic(result!.body)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Path 4: purged post → 200 tombstone PNG
// ---------------------------------------------------------------------------

describe('handleOgImageRoute — purged post', () => {
  beforeEach(() => stubSquidPost(PURGED_POST))

  test('returns 200', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/17', DEPS)
    expect(result!.status).toBe(200)
  })

  test('content-type is image/png', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/17', DEPS)
    expect(result!.contentType).toBe('image/png')
  })

  test('body starts with PNG magic bytes', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/17', DEPS)
    expect(isPngMagic(result!.body)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Path 5: live post → 200 real card PNG
// ---------------------------------------------------------------------------

describe('handleOgImageRoute — live post', () => {
  beforeEach(() => stubSquidPost(LIVE_POST))

  test('returns 200', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/17', DEPS)
    expect(result!.status).toBe(200)
  })

  test('content-type is image/png', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/17', DEPS)
    expect(result!.contentType).toBe('image/png')
  })

  test('body starts with PNG magic bytes', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/17', DEPS)
    expect(isPngMagic(result!.body)).toBe(true)
  })

  test('body has non-trivial length (not blank/corrupt)', async () => {
    const result = await handleOgImageRoute('/og/post/ethereum/17', DEPS)
    // A 1200x630 PNG with any content should be well above 10KB.
    // (A completely blank card would still be > 1KB due to PNG overhead.)
    // We use 5KB as the lower bound — defensively loose.
    const body = result!.body as Uint8Array
    expect(body.length).toBeGreaterThan(5_000)
  })
})

// ---------------------------------------------------------------------------
// Route matching: non-OG paths should return null
// ---------------------------------------------------------------------------

describe('handleOgImageRoute — routing', () => {
  test('returns null for non-og-image paths', async () => {
    const result = await handleOgImageRoute('/post/ethereum/17', DEPS)
    expect(result).toBeNull()
  })

  test('returns null for /graphql path', async () => {
    const result = await handleOgImageRoute('/graphql', DEPS)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Font guard — assertFontsExist
// ---------------------------------------------------------------------------
//
// Verifies the fail-loud guard that prevents silent blank-card rendering
// when a bundled font is missing (e.g. Dockerfile COPY regression).
//
// The helper is pure: same inputs → same output, no side effects beyond
// throwing. We test it directly via __internal so we never need to
// invalidate the real FONT_FILES on disk.

describe('assertFontsExist', () => {
  const { assertFontsExist, FONT_FILES } = __internal

  test('throws with the exact missing path when given a nonexistent path', () => {
    const bogus = '/nonexistent/path/to/BogusFont.ttf'
    expect(() => assertFontsExist([bogus])).toThrow(bogus)
  })

  test('thrown message mentions bundled-font / asset-copy problem', () => {
    const bogus = '/no/such/BogusFont.ttf'
    let message = ''
    try {
      assertFontsExist([bogus])
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    // The error message should guide the operator toward the root cause.
    expect(message).toMatch(/font/i)
  })

  test('does not throw when all paths exist (real FONT_FILES)', () => {
    expect(() => assertFontsExist(FONT_FILES)).not.toThrow()
  })

  test('throws on the first missing path even when others exist', () => {
    const [firstReal] = FONT_FILES
    const bogus = '/nonexistent/BogusFont.ttf'
    // Mix a real path and a bogus one — guard must catch the missing one.
    expect(() => assertFontsExist([firstReal!, bogus])).toThrow(bogus)
  })
})
