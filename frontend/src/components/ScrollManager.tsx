/**
 * ScrollManager — mounts once inside <BrowserRouter>, renders null.
 *
 * Behaviour:
 *   - POP (browser/OS back or forward): restore the saved scroll position
 *     for the destination history entry (keyed by location.key).
 *     Re-applies the restore on the next animation frame so react-query
 *     synchronously-rendered rows (staleTime=30 s) that resize a frame
 *     later don't clamp the scroll short.
 *   - PUSH / REPLACE (forward navigation): scroll to the top.
 *
 * Positions are saved keyed by location.key in a useRef<Map> so they
 * persist for the whole session without triggering re-renders.
 *
 * history.scrollRestoration is set to 'manual' once so the browser's own
 * heuristic doesn't fight us.
 */
import { useEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

export function ScrollManager(): null {
  const location = useLocation()
  const navType = useNavigationType()

  // Keyed by location.key (unique per history entry, stable on revisit).
  const positions = useRef<Map<string, number>>(new Map())

  // Disable the browser's own scroll-restoration once, globally.
  useEffect(() => {
    if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual'
    }
  }, [])

  useEffect(() => {
    const key = location.key

    if (navType === 'POP') {
      const saved = positions.current.get(key) ?? 0
      // Apply immediately…
      window.scrollTo(0, saved)
      // …and re-apply one frame later so any layout that occurs during
      // react-query's synchronous cache-hit render doesn't clamp us short.
      const rafId = requestAnimationFrame(() => {
        window.scrollTo(0, saved)
      })
      return () => {
        cancelAnimationFrame(rafId)
        // Save current scroll before leaving this entry.
        positions.current.set(key, window.scrollY)
      }
    } else {
      // PUSH or REPLACE — always start at the top.
      window.scrollTo(0, 0)
      return () => {
        // Save current scroll before leaving this entry.
        positions.current.set(key, window.scrollY)
      }
    }
  }, [location.key, navType])

  return null
}
