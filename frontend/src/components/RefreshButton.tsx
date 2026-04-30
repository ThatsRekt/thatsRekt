interface RefreshButtonProps {
  /** Triggered on click. Caller is responsible for triggering the actual refetch(es). */
  onRefresh: () => void
  /** True while either the feed query or the indexer-status query is in flight. */
  isFetching: boolean
}

/**
 * Brutalist refresh control for the feed header.
 *
 * Visually matches the existing FilterBar buttons (border-2 border-black,
 * uppercase tracking-widest, no rounded corners). Disabled while a refetch
 * is in progress — clicking again would queue a duplicate request and the
 * spinner already conveys "working".
 *
 * No popup on success — the staleness indicator next to this button
 * updates and the data on screen reloads, which is feedback enough.
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
        'inline-flex items-center gap-1.5 px-2 py-0.5 text-xs uppercase tracking-widest font-black ' +
        'border-2 border-black hover:bg-black hover:text-[#f5f4ee] ' +
        'focus:outline-none focus:ring-2 focus:ring-red-600 ' +
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-current ' +
        'transition-colors'
      }
    >
      {isFetching ? <Spinner /> : <RefreshGlyph />}
      <span>{isFetching ? 'refreshing…' : 'refresh'}</span>
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
