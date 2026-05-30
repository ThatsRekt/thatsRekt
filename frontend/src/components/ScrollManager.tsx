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
 * Scroll positions are saved continuously by a passive scroll listener
 * (keyed by the CURRENT history entry key) via a ref. This guarantees
 * the pre-navigation scroll position (e.g. 700 on the feed) is captured
 * BEFORE the browser ever has a chance to clamp it.
 *
 * The key insight: the old approach saved positions in useEffect cleanup,
 * which runs AFTER React commits and paints the destination route. At that
 * point the DOM shows the (shorter) destination page and the browser has
 * already clamped window.scrollY — so the cleanup was saving the clamped
 * value (e.g. 219), not the real feed position (700).
 *
 * The scroll listener captures the true position continuously while the
 * user is on the page, well before any navigation occurs.
 *
 * history.scrollRestoration is set to 'manual' once so the browser's own
 * heuristic doesn't fight us.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
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

  // Tracks the CURRENT history entry key. Updated synchronously in
  // useLayoutEffect so the scroll listener always writes to the right slot.
  const currentKey = useRef<string>(location.key)

  // Disable the browser's own scroll-restoration once, globally.
  useEffect(() => {
    if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual'
    }
  }, [])

  // Passive, rAF-throttled scroll listener — continuously records the true
  // scroll position for the CURRENT history entry.  By recording on every
  // scroll event we capture the real feed position (e.g. 700) long before
  // the user navigates away.  The listener always writes to currentKey.current
  // so it is immune to stale closure issues.
  useEffect(() => {
    let pendingRaf: number | null = null

    function onScroll(): void {
      if (pendingRaf !== null) return
      pendingRaf = window.requestAnimationFrame(() => {
        pendingRaf = null
        positions.current.set(currentKey.current, window.scrollY)
      })
    }

    window.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      window.removeEventListener('scroll', onScroll)
      if (pendingRaf !== null) {
        window.cancelAnimationFrame(pendingRaf)
        pendingRaf = null
      }
    }
  }, [])

  // Update currentKey synchronously BEFORE paint (useLayoutEffect) so that
  // any clamp-scroll the browser fires when it commits the shorter destination
  // page is recorded against the NEW entry's key — not the one we're leaving.
  useLayoutEffect(() => {
    currentKey.current = location.key
  }, [location.key])

  useEffect(() => {
    const key = location.key

    if (navType === 'POP') {
      // Snapshot the saved value immediately into a local const so that any
      // scroll events fired during the restore poll cannot shift our target.
      const saved = positions.current.get(key) ?? 0

      // If target is top, a single call is enough — 0 is always reachable.
      if (saved === 0) {
        window.scrollTo(0, 0)
        return
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
      }
    } else {
      // PUSH or REPLACE.
      // Seed the position map so POPs back here start from 0.
      positions.current.set(key, 0)

      if (location.hash) {
        // The target route may render asynchronously (e.g. /docs lazy-loads
        // its sections), so the element may not be in the DOM on the first
        // frame.  Mirror the rAF-poll pattern used by DocsTOC: retry for up
        // to POLL_DEADLINE_MS before falling back to top-of-page.
        const id = location.hash.slice(1)
        const startTime = performance.now()
        let rafId: number | null = null

        function pollHash(): void {
          const el = document.getElementById(id)
          if (el) {
            el.scrollIntoView({ behavior: 'auto', block: 'start' })
            rafId = null
            return
          }

          if (performance.now() - startTime > POLL_DEADLINE_MS) {
            // Element never appeared — fall back to top.
            window.scrollTo(0, 0)
            rafId = null
            return
          }

          rafId = window.requestAnimationFrame(pollHash)
        }

        rafId = window.requestAnimationFrame(pollHash)

        return () => {
          if (rafId !== null) {
            window.cancelAnimationFrame(rafId)
            rafId = null
          }
        }
      }

      // No hash — scroll to top.
      window.scrollTo(0, 0)
      return
    }
  }, [location.key, navType])

  return null
}
