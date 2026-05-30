/**
 * Unit tests for the pure message formatter.
 *
 * No DB, no network. All inputs are synthesized in-process.
 */
import { describe, expect, test } from 'bun:test'
import { escapeHtml, formatApplication, parseExtraContacts } from '../src/format.ts'
import type { ApplicationRow } from '../src/db.ts'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const baseRow = (): ApplicationRow => ({
  id: '42',
  created_at: new Date('2026-05-30T12:00:00.000Z'),
  primary_contact_type: 'telegram',
  primary_contact_value: '@guardian_alice',
  extra_contacts: null,
  justification:
    'I have been monitoring DeFi exploits for 3 years and contributed to securing multiple protocols. I want to help protect the community by being a verified guardian on thatsRekt.',
  source_ip_hash: null,
})

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  test('passes through plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
  })

  test('escapes &', () => {
    expect(escapeHtml('A & B')).toBe('A &amp; B')
  })

  test('escapes <', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
  })

  test('escapes >', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b')
  })

  test('escapes "', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;')
  })

  test('escapes all four in combination', () => {
    expect(escapeHtml('<a href="x">foo & bar</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;foo &amp; bar&lt;/a&gt;',
    )
  })
})

// ---------------------------------------------------------------------------
// parseExtraContacts
// ---------------------------------------------------------------------------

describe('parseExtraContacts', () => {
  test('returns empty array for null', () => {
    expect(parseExtraContacts(null)).toEqual([])
  })

  test('returns empty array for undefined', () => {
    expect(parseExtraContacts(undefined)).toEqual([])
  })

  test('returns empty array for malformed JSON', () => {
    expect(parseExtraContacts('not-json')).toEqual([])
  })

  test('returns empty array for non-array object', () => {
    expect(parseExtraContacts({ type: 'email', value: 'x@x.com' })).toEqual([])
  })

  test('returns empty array for array with invalid entry type', () => {
    expect(parseExtraContacts([{ type: 'fax', value: '555-1234' }])).toEqual([])
  })

  test('parses a valid single extra contact', () => {
    const contacts = parseExtraContacts([{ type: 'email', value: 'alice@example.com' }])
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toEqual({ type: 'email', value: 'alice@example.com' })
  })

  test('parses multiple valid extra contacts', () => {
    const contacts = parseExtraContacts([
      { type: 'email', value: 'alice@example.com' },
      { type: 'signal', value: '+15550001234' },
    ])
    expect(contacts).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// formatApplication
// ---------------------------------------------------------------------------

describe('formatApplication', () => {
  test('contains the application ID', () => {
    const msg = formatApplication(baseRow())
    expect(msg).toContain('42')
  })

  test('contains "New Guardian Application" header', () => {
    const msg = formatApplication(baseRow())
    expect(msg).toContain('New Guardian Application')
  })

  test('contains the primary contact type label', () => {
    const msg = formatApplication(baseRow())
    expect(msg).toContain('Telegram')
  })

  test('contains the primary contact value', () => {
    const msg = formatApplication(baseRow())
    expect(msg).toContain('@guardian_alice')
  })

  test('contains the justification text', () => {
    const row = baseRow()
    const msg = formatApplication(row)
    expect(msg).toContain(row.justification)
  })

  test('contains the submission ISO timestamp', () => {
    const msg = formatApplication(baseRow())
    expect(msg).toContain('2026-05-30T12:00:00.000Z')
  })

  test('does not contain em-dashes', () => {
    const msg = formatApplication(baseRow())
    expect(msg).not.toContain('—') // —
  })

  test('omits source IP section when source_ip_hash is null', () => {
    const msg = formatApplication(baseRow())
    expect(msg).not.toContain('Source IP hash')
  })

  test('includes source IP hash when present', () => {
    const row = baseRow()
    row.source_ip_hash = 'abc123'
    const msg = formatApplication(row)
    expect(msg).toContain('Source IP hash')
    expect(msg).toContain('abc123')
  })

  test('omits additional contacts section when extra_contacts is null', () => {
    const msg = formatApplication(baseRow())
    expect(msg).not.toContain('Additional contacts')
  })

  test('includes extra contacts when present', () => {
    const row = baseRow()
    row.extra_contacts = [{ type: 'email', value: 'alice@example.com' }]
    const msg = formatApplication(row)
    expect(msg).toContain('Additional contacts')
    expect(msg).toContain('alice@example.com')
    expect(msg).toContain('Email')
  })

  test('escapes HTML in contact values', () => {
    const row = baseRow()
    row.primary_contact_value = '<evil>hack</evil>'
    const msg = formatApplication(row)
    expect(msg).toContain('&lt;evil&gt;hack&lt;/evil&gt;')
    // Raw angle brackets must not appear in the escaped output
    expect(msg).not.toContain('<evil>')
  })

  test('escapes HTML in justification', () => {
    const row = baseRow()
    row.justification =
      'I am a security researcher & ethical hacker. I have found vulnerabilities in <protocol> and disclosed them responsibly to protect users and their funds.'
    const msg = formatApplication(row)
    expect(msg).toContain('&amp;')
    expect(msg).toContain('&lt;protocol&gt;')
  })

  test('Twitter / X label for twitter contact type', () => {
    const row = baseRow()
    row.primary_contact_type = 'twitter'
    row.primary_contact_value = '@alice_sec'
    const msg = formatApplication(row)
    expect(msg).toContain('Twitter / X')
  })

  test('message is a non-empty string', () => {
    const msg = formatApplication(baseRow())
    expect(typeof msg).toBe('string')
    expect(msg.length).toBeGreaterThan(0)
  })
})
