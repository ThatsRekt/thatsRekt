interface RefreshButtonProps {
  /** Triggered on click. Caller is responsible for triggering the actual refetch(es). */
  onRefresh: () => void
  /** True while a refetch is in progress; renders a spinner instead of the refresh glyph. */
  isFetching: boolean
}

/**
 * Compact icon-only refresh control for the feed header — sits at the
 * far right of the FilterBar. Brutalist 1-px black border, square,
 * inverts on hover to match the chain selector trigger.
 *
 * Disabled while in flight; the spinner conveys progress. Label hidden
 * visually but exposed via aria-label for screen readers.
 */
export function RefreshButton({ onRefresh, isFetching }: RefreshButtonProps) {
  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={isFetching}
      aria-label={isFetching ? 'refreshing feed' : 'refresh feed'}
      aria-busy={isFetching}
      className={
        'inline-flex items-center justify-center w-7 h-7 ' +
        'border border-black hover:bg-black hover:text-[#f5f4ee] ' +
        'focus:outline-none focus:ring-2 focus:ring-red-600 ' +
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-current ' +
        'transition-colors'
      }
    >
      {isFetching ? <Spinner /> : <RefreshGlyph />}
    </button>
  )
}

const Spinner = () => (
  // Simple two-segment spinner — pure CSS, no extra dependency.
  <span
    aria-hidden="true"
    className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
  />
)

const RefreshGlyph = () => (
  // Inline SVG keeps the icon crisp and color-inheriting; no icon library
  // is wired into this project and we shouldn't add one for a single glyph.
  <svg
    aria-hidden="true"
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="square"
    strokeLinejoin="miter"
  >
    <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
    <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M3 21v-5h5" />
  </svg>
)
