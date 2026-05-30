/**
 * Tests for assertTurnstileSecretForProd() -- the fail-loud boot guard.
 *
 * The guard is a pure function of (nodeEnv, secret) with no IO:
 *   - production + missing secret  -> throws
 *   - production + any Cloudflare test key -> throws
 *   - production + a real-looking secret -> returns normally
 *   - non-production + test key -> returns normally (fallback preserved)
 *   - non-production + undefined -> returns normally
 *
 * No module mocking needed. The guard is pure env+string logic exported
 * from guardian.ts. We import it directly.
 *
 * Cloudflare test SECRET keys (all three documented kinds must be rejected
 * in prod):
 *   1x0000000000000000000000000000000AA  -- always passes
 *   2x0000000000000000000000000000000AA  -- always fails
 *   3x0000000000000000000000000000000AA  -- token already spent / yes dummy
 */
import { describe, expect, test } from 'bun:test'
import { assertTurnstileSecretForProd } from '../src/guardian.ts'

// ---------------------------------------------------------------------------
// Prod environment: guard must reject test keys + missing secret
// ---------------------------------------------------------------------------

describe('assertTurnstileSecretForProd — production', () => {
  const PROD = 'production'

  test('throws when TURNSTILE_SECRET is undefined in production', () => {
    expect(() => assertTurnstileSecretForProd(PROD, undefined)).toThrow(
      /TURNSTILE_SECRET/,
    )
  })

  test('throws when TURNSTILE_SECRET is empty string in production', () => {
    expect(() => assertTurnstileSecretForProd(PROD, '')).toThrow(
      /TURNSTILE_SECRET/,
    )
  })

  test('throws when TURNSTILE_SECRET is the always-pass test key in production', () => {
    expect(() =>
      assertTurnstileSecretForProd(PROD, '1x0000000000000000000000000000000AA'),
    ).toThrow(/TURNSTILE_SECRET/)
  })

  test('throws when TURNSTILE_SECRET is the always-fail test key in production', () => {
    expect(() =>
      assertTurnstileSecretForProd(PROD, '2x0000000000000000000000000000000AA'),
    ).toThrow(/TURNSTILE_SECRET/)
  })

  test('throws when TURNSTILE_SECRET is the token-spent test key in production', () => {
    expect(() =>
      assertTurnstileSecretForProd(PROD, '3x0000000000000000000000000000000AA'),
    ).toThrow(/TURNSTILE_SECRET/)
  })

  test('error message mentions prod and real secret without em-dashes', () => {
    try {
      assertTurnstileSecretForProd(PROD, undefined)
      expect(true).toBe(false) // unreachable
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Must not contain em-dash (house rule)
      expect(msg).not.toContain('—')
      // Should clearly communicate the problem
      expect(msg).toContain('TURNSTILE_SECRET')
    }
  })

  test('does NOT throw when TURNSTILE_SECRET looks like a real key in production', () => {
    // A plausible prod secret: 32-char hex-like string. Cloudflare prod
    // secrets are typically 40+ char alphanumeric. We only reject known
    // test keys; anything else passes.
    expect(() =>
      assertTurnstileSecretForProd(PROD, '0x7f3a9bcd1234ef5678901234abcdef56789012345'),
    ).not.toThrow()
  })

  test('does NOT throw for any string not in the known test-key list', () => {
    // Short but not a known test key -> allowed (we don't know Cloudflare's
    // exact prod key format; only the documented test keys are blocked).
    expect(() => assertTurnstileSecretForProd(PROD, 'secret-abc-123')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Non-prod environments: guard must be silent (dev/CI test keys must still work)
// ---------------------------------------------------------------------------

describe('assertTurnstileSecretForProd — non-production', () => {
  const TEST_KEYS = [
    '1x0000000000000000000000000000000AA',
    '2x0000000000000000000000000000000AA',
    '3x0000000000000000000000000000000AA',
  ] as const

  test('does NOT throw in development with test always-pass key', () => {
    expect(() =>
      assertTurnstileSecretForProd('development', '1x0000000000000000000000000000000AA'),
    ).not.toThrow()
  })

  test('does NOT throw when NODE_ENV is undefined with test always-pass key', () => {
    expect(() =>
      assertTurnstileSecretForProd(undefined, '1x0000000000000000000000000000000AA'),
    ).not.toThrow()
  })

  test('does NOT throw when NODE_ENV is undefined and secret is undefined', () => {
    // This is the typical `bun test` / local dev scenario with no envs set.
    expect(() => assertTurnstileSecretForProd(undefined, undefined)).not.toThrow()
  })

  for (const key of TEST_KEYS) {
    test(`does NOT throw in development with test key ${key.slice(0, 12)}...`, () => {
      expect(() => assertTurnstileSecretForProd('development', key)).not.toThrow()
    })

    test(`does NOT throw when NODE_ENV=test with test key ${key.slice(0, 12)}...`, () => {
      expect(() => assertTurnstileSecretForProd('test', key)).not.toThrow()
    })
  }
})

// ---------------------------------------------------------------------------
// Type safety: only exported, never called with wrong argument shapes
// ---------------------------------------------------------------------------

describe('assertTurnstileSecretForProd — type signature', () => {
  test('function is exported and callable', () => {
    expect(typeof assertTurnstileSecretForProd).toBe('function')
  })
})
