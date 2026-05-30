/**
 * Unit tests for guardian application validation helpers (pure functions).
 *
 * Tests run with bun:test against src/lib/guardian.ts.
 * No DOM, no network — pure logic only.
 */
import { describe, expect, test } from 'bun:test'
import {
  validateContactValue,
  validateJustification,
  JUSTIFICATION_MIN,
  JUSTIFICATION_MAX,
  CONTACT_VALUE_MAX,
} from '../src/lib/guardian'

// ---------------------------------------------------------------------------
// validateJustification
// ---------------------------------------------------------------------------

describe('validateJustification', () => {
  test('returns null for exactly JUSTIFICATION_MIN chars', () => {
    expect(validateJustification('a'.repeat(JUSTIFICATION_MIN))).toBeNull()
  })

  test('returns null for exactly JUSTIFICATION_MAX chars', () => {
    expect(validateJustification('a'.repeat(JUSTIFICATION_MAX))).toBeNull()
  })

  test('returns null for a mid-range value', () => {
    expect(validateJustification('a'.repeat(200))).toBeNull()
  })

  test('returns error for text shorter than JUSTIFICATION_MIN', () => {
    const result = validateJustification('a'.repeat(JUSTIFICATION_MIN - 1))
    expect(result).not.toBeNull()
    expect(result).toInclude(String(JUSTIFICATION_MIN))
  })

  test('returns error for empty string', () => {
    expect(validateJustification('')).not.toBeNull()
  })

  test('returns error for text longer than JUSTIFICATION_MAX', () => {
    const result = validateJustification('a'.repeat(JUSTIFICATION_MAX + 1))
    expect(result).not.toBeNull()
    expect(result).toInclude(String(JUSTIFICATION_MAX))
  })
})

// ---------------------------------------------------------------------------
// validateContactValue — telegram
// ---------------------------------------------------------------------------

describe('validateContactValue — telegram', () => {
  test('accepts valid @handle', () => {
    expect(validateContactValue('telegram', '@alice_123')).toBeNull()
  })

  test('accepts @handle with max 64 chars after @', () => {
    expect(validateContactValue('telegram', '@' + 'a'.repeat(64))).toBeNull()
  })

  test('rejects handle without leading @', () => {
    expect(validateContactValue('telegram', 'alice')).not.toBeNull()
  })

  test('rejects handle that is just @', () => {
    expect(validateContactValue('telegram', '@')).not.toBeNull()
  })

  test('rejects handle with invalid chars (hyphen)', () => {
    expect(validateContactValue('telegram', '@alice-bob')).not.toBeNull()
  })

  test('rejects handle longer than 64 chars after @', () => {
    expect(validateContactValue('telegram', '@' + 'a'.repeat(65))).not.toBeNull()
  })

  test('rejects empty value', () => {
    expect(validateContactValue('telegram', '')).not.toBeNull()
  })

  test('rejects value longer than CONTACT_VALUE_MAX', () => {
    expect(validateContactValue('telegram', '@' + 'a'.repeat(CONTACT_VALUE_MAX))).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validateContactValue — twitter
// ---------------------------------------------------------------------------

describe('validateContactValue — twitter', () => {
  test('accepts valid @handle', () => {
    expect(validateContactValue('twitter', '@guardian_eth')).toBeNull()
  })

  test('accepts @handle with max 50 chars after @', () => {
    expect(validateContactValue('twitter', '@' + 'a'.repeat(50))).toBeNull()
  })

  test('rejects handle longer than 50 chars after @', () => {
    expect(validateContactValue('twitter', '@' + 'a'.repeat(51))).not.toBeNull()
  })

  test('rejects handle without leading @', () => {
    expect(validateContactValue('twitter', 'guardian_eth')).not.toBeNull()
  })

  test('rejects empty value', () => {
    expect(validateContactValue('twitter', '')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validateContactValue — signal
// ---------------------------------------------------------------------------

describe('validateContactValue — signal', () => {
  test('accepts valid E.164 number', () => {
    expect(validateContactValue('signal', '+15555550100')).toBeNull()
  })

  test('accepts international number', () => {
    expect(validateContactValue('signal', '+442071838750')).toBeNull()
  })

  test('rejects number without +', () => {
    expect(validateContactValue('signal', '15555550100')).not.toBeNull()
  })

  test('rejects +0 (leading zero in country code)', () => {
    expect(validateContactValue('signal', '+0123456789')).not.toBeNull()
  })

  test('rejects too-short number (fewer than 7 digits after +country)', () => {
    // E.164 min is +country + 6 subscriber = 7 digits total after +
    expect(validateContactValue('signal', '+1234')).not.toBeNull()
  })

  test('rejects non-digits after +', () => {
    expect(validateContactValue('signal', '+1abc5550100')).not.toBeNull()
  })

  test('rejects empty value', () => {
    expect(validateContactValue('signal', '')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// validateContactValue — email
// ---------------------------------------------------------------------------

describe('validateContactValue — email', () => {
  test('accepts valid email', () => {
    expect(validateContactValue('email', 'user@example.com')).toBeNull()
  })

  test('accepts email with subdomain', () => {
    expect(validateContactValue('email', 'user@mail.example.co.uk')).toBeNull()
  })

  test('rejects email without @', () => {
    expect(validateContactValue('email', 'userexample.com')).not.toBeNull()
  })

  test('rejects email with spaces', () => {
    expect(validateContactValue('email', 'user @example.com')).not.toBeNull()
  })

  test('rejects email without domain extension', () => {
    expect(validateContactValue('email', 'user@example')).not.toBeNull()
  })

  test('rejects empty value', () => {
    expect(validateContactValue('email', '')).not.toBeNull()
  })

  test('rejects value over CONTACT_VALUE_MAX chars', () => {
    const longEmail = 'a'.repeat(CONTACT_VALUE_MAX) + '@b.com'
    expect(validateContactValue('email', longEmail)).not.toBeNull()
  })
})
