/**
 * BackLink — drop-in replacement for the 3 raw <Link to="/"> "← back to feed"
 * links in PostDetail and ArchiveDetail.
 *
 * Renders as a standard <Link to="/"> (preserves <a> semantics: right-click,
 * open-in-new-tab, cold deep-link fallback all work exactly as before).
 *
 * Intercepts a primary left-click with no modifier keys when
 * window.history.state?.idx > 0 (i.e., the user arrived here via in-app
 * navigation rather than a direct URL load). In that case it calls
 * navigate(-1) — a POP — so ScrollManager restores the feed's scroll position
 * consistently with the OS back gesture.
 *
 * When idx is 0 or absent (cold deep-link), the Link's default PUSH to "/"
 * fires normally.
 */
import type { ReactElement, ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'

interface BackLinkProps {
  children?: ReactNode
  className?: string
}

export function BackLink({ children, className }: BackLinkProps): ReactElement {
  const navigate = useNavigate()

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>): void {
    // Let modifier keys (Ctrl/Cmd/Shift/Alt) and non-primary buttons fall
    // through so "open in new tab", right-click menus, etc. work as expected.
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
      return
    }

    // Only intercept if there's in-app history to pop back to.
    const idx = (window.history.state as { idx?: number } | null)?.idx
    if (typeof idx === 'number' && idx > 0) {
      e.preventDefault()
      navigate(-1)
    }
    // idx === 0 or absent → let Link handle navigation to "/"
  }

  return (
    <Link to="/" className={className} onClick={handleClick}>
      {children}
    </Link>
  )
}
