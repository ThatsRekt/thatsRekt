/**
 * sortState — pure reducer for the donations timeline sort controls.
 *
 * A column-header click produces the next {orderBy, direction}:
 *   - Clicking the active column toggles direction (ASC -> DESC, DESC -> ASC).
 *   - Clicking a different column resets to that column's default direction.
 *
 * Default directions per column (what makes intuitive sense on first click):
 *   date:   DESC — newest first (the natural default)
 *   amount: DESC — largest first (most interesting at top)
 *   donor:  ASC  — alphabetical
 *   chain:  ASC  — alphabetical
 *   token:  ASC  — alphabetical
 *
 * This module has zero side effects and is safe to import anywhere.
 */

export type OrderColumn = 'date' | 'amount' | 'chain' | 'token' | 'donor'
export type Direction = 'ASC' | 'DESC'

export interface SortState {
  readonly orderBy: OrderColumn
  readonly direction: Direction
}

/** Default: newest-first (date DESC). */
export const DEFAULT_SORT_STATE: SortState = Object.freeze({
  orderBy: 'date' as const,
  direction: 'DESC' as const,
})

/**
 * The default direction applied when switching to a new column.
 * Clicking the active column always toggles instead.
 */
const COLUMN_DEFAULT_DIRECTION: Readonly<Record<OrderColumn, Direction>> = Object.freeze({
  date: 'DESC',
  amount: 'DESC',
  donor: 'ASC',
  chain: 'ASC',
  token: 'ASC',
})

/**
 * Pure reducer: given current sort state and the column just clicked,
 * return the next sort state.
 *
 * @param state   Current sort state (not mutated).
 * @param clicked The column the user just clicked.
 * @returns       New sort state (new object, never mutates input).
 */
export function sortStateReducer(state: SortState, clicked: OrderColumn): SortState {
  if (state.orderBy === clicked) {
    // Same column: toggle direction.
    return {
      orderBy: clicked,
      direction: state.direction === 'ASC' ? 'DESC' : 'ASC',
    }
  }
  // Different column: reset to that column's default direction.
  return {
    orderBy: clicked,
    direction: COLUMN_DEFAULT_DIRECTION[clicked],
  }
}
