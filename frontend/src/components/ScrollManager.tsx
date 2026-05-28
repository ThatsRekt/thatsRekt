/**
 * ScrollManager — mounts once inside <BrowserRouter>, renders null.
 *
 * Behaviour:
 *   - POP (browser/OS back or forward): restore the saved scroll position
 *     for the destination history entry (keyed by location.key).
 *
 *     The restore is driven by a requestAnimationFrame polling loop that
 *     calls window.scrollTo(0, saved) every frame and checks whether
 *     window.scrollY landed within REACH_TOLERANCE_PX of the target.
 *     This handles the cold-path race where the feed list renders
 *     asynchronously AFTER the POP, making the document progressively
 *     taller over several frames.  Each frame re-applies scrollTo; once
 *     the content is tall enough that the saved position is reachable,
 *     the scroll sticks, scrollY reaches the target, and the loop stops.
 *
 *     A hard POLL_DEADLINE_MS cap aborts the loop to prevent leaks.
 *     The rAF id is cancelled in effect cleanup so a new navigation
 *     always aborts an in-flight restore.
 *
 *     If saved === 0, we scroll to top once and skip the loop (nothing to
 *     poll for — 0 is always reachable).
 *
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

/** Tolerance in pixels: within this distance we consider the target reached. */
const REACH_TOLERANCE_PX = 2

/** Maximum time (ms) we keep the rAF loop running waiting for the page to grow. */
const POLL_DEADLINE_MS = 1000

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

      // If target is top, a single call is enough — 0 is always reachable.
      if (saved === 0) {
        window.scrollTo(0, 0)
        return () => {
          positions.current.set(key, window.scrollY)
        }
      }

      // rAF polling loop: re-apply scrollTo every frame until scrollY reaches
      // the saved position (within tolerance) or the deadline expires.
      // Each frame the browser may have laid out more content, making the
      // document taller and the target reachable where it wasn't before.
      const startTime = performance.now()
      let rafId: number | null = null

      function poll(): void {
        window.scrollTo(0, saved)

        if (Math.abs(window.scrollY - saved) <= REACH_TOLERANCE_PX) {
          // Target reached — stop polling.
          rafId = null
          return
        }

        if (performance.now() - startTime > POLL_DEADLINE_MS) {
          // Deadline expired — stop to prevent leaks.
          rafId = null
          return
        }

        rafId = window.requestAnimationFrame(poll)
      }

      rafId = window.requestAnimationFrame(poll)

      return () => {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId)
          rafId = null
        }
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
