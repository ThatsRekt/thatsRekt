/**
 * Unit tests for donations module — orderByClause pure helper.
 * Written test-first (TDD).
 */
import { describe, expect, test } from 'bun:test'
import { orderByClause } from '../src/donations.ts'

describe('orderByClause', () => {
  test('date DESC produces "block_timestamp DESC"', () => {
    expect(orderByClause('date', 'DESC')).toBe('block_timestamp DESC')
  })

  test('date ASC produces "block_timestamp ASC"', () => {
    expect(orderByClause('date', 'ASC')).toBe('block_timestamp ASC')
  })

  test('amount DESC produces "amount_norm DESC"', () => {
    expect(orderByClause('amount', 'DESC')).toBe('amount_norm DESC')
  })

  test('amount ASC produces "amount_norm ASC"', () => {
    expect(orderByClause('amount', 'ASC')).toBe('amount_norm ASC')
  })

  test('chain DESC produces "chain_slug DESC"', () => {
    expect(orderByClause('chain', 'DESC')).toBe('chain_slug DESC')
  })

  test('token DESC produces "token_symbol DESC"', () => {
    expect(orderByClause('token', 'DESC')).toBe('token_symbol DESC')
  })

  test('donor DESC produces "from_address DESC"', () => {
    expect(orderByClause('donor', 'DESC')).toBe('from_address DESC')
  })

  test('unknown column throws (injection guard)', () => {
    expect(() => orderByClause('DROP TABLE donation; --', 'DESC')).toThrow(
      'Unknown orderBy column',
    )
  })

  test('unknown column "id" throws', () => {
    expect(() => orderByClause('id', 'DESC')).toThrow('Unknown orderBy column')
  })

  test('invalid direction defaults to DESC (safe side)', () => {
    // Any non-'ASC' direction coerces to DESC for safety.
    expect(orderByClause('date', 'invalid')).toBe('block_timestamp DESC')
  })

  test('direction comparison is case-insensitive', () => {
    expect(orderByClause('date', 'asc')).toBe('block_timestamp ASC')
    expect(orderByClause('date', 'Asc')).toBe('block_timestamp ASC')
  })
})
