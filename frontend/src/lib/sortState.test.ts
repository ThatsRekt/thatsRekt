/**
 * Unit tests for sortState reducer — pure function, test-first (TDD).
 *
 * The reducer handles column-header click transitions:
 *   - Clicking the current column toggles direction (ASC -> DESC, DESC -> ASC).
 *   - Clicking a different column resets to that column's default direction.
 *
 * Default direction on first click of a column:
 *   - date:   DESC (newest first — the natural default)
 *   - amount: DESC (largest first — most interesting at the top)
 *   - donor:  ASC  (alphabetical)
 *   - chain:  ASC  (alphabetical)
 *   - token:  ASC  (alphabetical)
 */
import { describe, expect, test } from 'bun:test'
import { sortStateReducer, DEFAULT_SORT_STATE } from './sortState'

describe('DEFAULT_SORT_STATE', () => {
  test('default is date DESC (newest first)', () => {
    expect(DEFAULT_SORT_STATE.orderBy).toBe('date')
    expect(DEFAULT_SORT_STATE.direction).toBe('DESC')
  })
})

describe('sortStateReducer — same-column toggle', () => {
  test('clicking date when already date/DESC toggles to ASC', () => {
    const next = sortStateReducer({ orderBy: 'date', direction: 'DESC' }, 'date')
    expect(next.orderBy).toBe('date')
    expect(next.direction).toBe('ASC')
  })

  test('clicking date when already date/ASC toggles to DESC', () => {
    const next = sortStateReducer({ orderBy: 'date', direction: 'ASC' }, 'date')
    expect(next.orderBy).toBe('date')
    expect(next.direction).toBe('DESC')
  })

  test('clicking amount when already amount/ASC toggles to DESC', () => {
    const next = sortStateReducer({ orderBy: 'amount', direction: 'ASC' }, 'amount')
    expect(next.orderBy).toBe('amount')
    expect(next.direction).toBe('DESC')
  })

  test('clicking amount when already amount/DESC toggles to ASC', () => {
    const next = sortStateReducer({ orderBy: 'amount', direction: 'DESC' }, 'amount')
    expect(next.orderBy).toBe('amount')
    expect(next.direction).toBe('ASC')
  })

  test('clicking donor toggles direction correctly', () => {
    const first = sortStateReducer({ orderBy: 'donor', direction: 'ASC' }, 'donor')
    expect(first.direction).toBe('DESC')
    const second = sortStateReducer(first, 'donor')
    expect(second.direction).toBe('ASC')
  })
})

describe('sortStateReducer — column switch resets to default direction', () => {
  test('switching from date to amount defaults to DESC', () => {
    const next = sortStateReducer({ orderBy: 'date', direction: 'ASC' }, 'amount')
    expect(next.orderBy).toBe('amount')
    expect(next.direction).toBe('DESC')
  })

  test('switching from date to donor defaults to ASC', () => {
    const next = sortStateReducer({ orderBy: 'date', direction: 'DESC' }, 'donor')
    expect(next.orderBy).toBe('donor')
    expect(next.direction).toBe('ASC')
  })

  test('switching from amount to chain defaults to ASC', () => {
    const next = sortStateReducer({ orderBy: 'amount', direction: 'DESC' }, 'chain')
    expect(next.orderBy).toBe('chain')
    expect(next.direction).toBe('ASC')
  })

  test('switching from donor to token defaults to ASC', () => {
    const next = sortStateReducer({ orderBy: 'donor', direction: 'DESC' }, 'token')
    expect(next.orderBy).toBe('token')
    expect(next.direction).toBe('ASC')
  })

  test('switching from amount to date defaults to DESC', () => {
    const next = sortStateReducer({ orderBy: 'amount', direction: 'ASC' }, 'date')
    expect(next.orderBy).toBe('date')
    expect(next.direction).toBe('DESC')
  })
})

describe('sortStateReducer — immutability', () => {
  test('does not mutate the input state', () => {
    const state = Object.freeze({ orderBy: 'date' as const, direction: 'DESC' as const })
    const next = sortStateReducer(state, 'amount')
    // The original state is unchanged
    expect(state.orderBy).toBe('date')
    expect(state.direction).toBe('DESC')
    // The new state is different
    expect(next.orderBy).toBe('amount')
  })
})

describe('sortStateReducer — all 5 columns are accepted', () => {
  const columns = ['date', 'amount', 'chain', 'token', 'donor'] as const
  for (const col of columns) {
    test(`column "${col}" is accepted`, () => {
      const next = sortStateReducer(DEFAULT_SORT_STATE, col)
      expect(next.orderBy).toBe(col)
    })
  }
})
