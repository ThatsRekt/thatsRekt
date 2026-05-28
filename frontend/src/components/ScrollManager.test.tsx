/**
 * Unit tests for ScrollManager.
 *
 * Strategy: mount ScrollManager inside a MemoryRouter whose initial entries
 * and nav type we control via react-router-dom test helpers. Assert that
 * window.scrollTo is called correctly on PUSH (→ top) and on POP
 * (→ saved position or 0 when no position was saved).
 *
 * happy-dom provides window/document globals via test/setup.ts.
 * We spy on window.scrollTo and clear it between each test.
 *
 * Note on rAF timing:
 *   ScrollManager calls window.requestAnimationFrame (not bare globalThis rAF)
 *   to avoid React act() intercepting and deferring the callbacks.
 *   happy-dom's window.requestAnimationFrame fires after ~16–50ms of real wall
 *   clock time. The simple tests wait 150ms AFTER act() returns to let it fire.
 *   The async-growth (clamping) test replaces window.requestAnimationFrame with
 *   a synchronous manual queue so it can drive individual poll ticks precisely.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { render, act, cleanup, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { ScrollManager } from './ScrollManager'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let scrollToSpy: ReturnType<typeof spyOn>

/**
 * Wait for pending window.requestAnimationFrame callbacks to fire.
 * happy-dom fires them after ~16–50ms; 150ms is a safe upper bound.
 * Must be called OUTSIDE of act() — React's act() intercepts globalThis.rAF
 * but NOT window.rAF; happy-dom fires the latter on its own real-time schedule.
 */
async function waitForRaf(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
}

beforeEach(() => {
  scrollToSpy = spyOn(window, 'scrollTo').mockImplementation(() => undefined)
})

afterEach(() => {
  scrollToSpy.mockRestore()
  cleanup()
})

/**
 * A helper page component that exposes a navigation trigger for testing.
 */
function NavigatorPage({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(to)}>
      {label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScrollManager', () => {
  it('scrolls to top on PUSH navigation', async () => {
    // Mount on "/" — the initial render is a PUSH.
    // saved === 0 on a fresh history entry, so ScrollManager scrolls once
    // directly (no rAF loop) — assertion is immediately after act.
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <ScrollManager />
        <Routes>
          <Route path="/" element={<NavigatorPage to="/post/base-1" label="go to post" />} />
          <Route path="/post/base-1" element={<div>post page</div>} />
        </Routes>
      </MemoryRouter>,
    )

    // Initial mount fires a scroll-to-top (PUSH on first entry)
    expect(scrollToSpy).toHaveBeenCalledWith(0, 0)
    scrollToSpy.mockClear()

    // Navigate forward — PUSH
    await act(async () => {
      within(container).getByText('go to post').click()
    })

    expect(scrollToSpy).toHaveBeenCalledWith(0, 0)
  })

  it('restores scroll position on POP navigation after a saved position', async () => {
    // Simulate: user was on "/" with scrollY = 400, navigated to a post,
    // then pressed back.  ScrollManager should restore 400 on the POP.
    //
    // Make the document tall so 400 is reachable from the first rAF tick.

    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 11000,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(window, 'innerHeight', {
      value: 768,
      writable: true,
      configurable: true,
    })

    let navigateRef: ((delta: number) => void) | null = null

    function BackNavigatorPage() {
      const navigate = useNavigate()
      navigateRef = (delta: number) => navigate(delta)
      return <div>post page</div>
    }

    // Render at "/" with scrollY=0 (initial no-op spy, direct scrollTo(0,0)).
    const { container } = render(
      <MemoryRouter initialEntries={['/', '/post/base-1']} initialIndex={0}>
        <ScrollManager />
        <Routes>
          <Route
            path="/"
            element={<NavigatorPage to="/post/base-1" label="go to post" />}
          />
          <Route path="/post/base-1" element={<BackNavigatorPage />} />
        </Routes>
      </MemoryRouter>,
    )

    // Prime scrollY=400 so the "/" cleanup saves it when we navigate away.
    Object.defineProperty(window, 'scrollY', { value: 400, writable: true, configurable: true })

    // Navigate to post (PUSH) — cleanup of "/" fires and saves scrollY=400.
    await act(async () => {
      within(container).getByText('go to post').click()
    })

    scrollToSpy.mockClear()

    // Simulate arriving at post at top.
    Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true })

    // Trigger POP — React effects run synchronously inside act().
    // The rAF loop is scheduled on window.requestAnimationFrame (not globalThis),
    // so act() does NOT intercept it.  We wait for it AFTER act() returns.
    await act(async () => {
      navigateRef!(-1)
    })

    // Wait for window.requestAnimationFrame to fire (outside act, real time).
    await waitForRaf()

    // Should restore the saved 400.
    expect(scrollToSpy).toHaveBeenCalledWith(0, 400)
  })

  it('scrolls to top (fallback) on POP when no position was saved', async () => {
    // Navigate forward and back without a pre-existing saved position.
    // saved === 0 (Map miss → default 0) so ScrollManager skips the rAF loop
    // and scrolls to top directly — no rAF wait needed.
    let navigateRef: ((delta: number) => void) | null = null

    function BackPage() {
      const navigate = useNavigate()
      navigateRef = (delta: number) => navigate(delta)
      return <div>back page</div>
    }

    const { container } = render(
      <MemoryRouter initialEntries={['/other', '/post/base-1']} initialIndex={0}>
        <ScrollManager />
        <Routes>
          <Route path="/other" element={<NavigatorPage to="/post/base-1" label="go to post" />} />
          <Route path="/post/base-1" element={<BackPage />} />
        </Routes>
      </MemoryRouter>,
    )

    await act(async () => {
      within(container).getByText('go to post').click()
    })

    scrollToSpy.mockClear()

    // Navigate back — no saved position → saved=0 → direct scrollTo(0,0), no loop.
    await act(async () => {
      navigateRef!(-1)
    })

    expect(scrollToSpy).toHaveBeenCalledWith(0, 0)
  })

  it('re-applies scroll on POP when the document grows after initial restore (rAF poll models real clamping)', async () => {
    // -------------------------------------------------------------------------
    // Reproduces the exact browser failure mode:
    //
    //   1. Stored feed position = 700.
    //   2. POP fires when document is SHORT (scrollHeight 300, innerHeight 768
    //      → maxScroll = 0). scrollTo(0, 700) clamps to 0 — scrollY stays 0.
    //   3. Several animation frames later feed renders: scrollHeight grows to
    //      11000 → maxScroll = 10232. scrollTo(0, 700) now sticks.
    //
    // The rAF polling loop re-applies scrollTo every frame. This test drives
    // each frame manually so we can assert the intermediate clamped state and
    // the final locked state precisely.
    //
    // Why a single-shot / ResizeObserver implementation FAILS this test:
    //   - Single-shot: scrollTo fires once while short → clamps → never corrects.
    //   - ResizeObserver on documentElement: observes the border-box, which
    //     stays ≈ viewport height regardless of scrollHeight growth → never fires.
    //
    // Setup sequence:
    //   1. Render component (no-op spy; no rAF stubbing yet — initial PUSH
    //      uses direct scrollTo(0,0) so the stub has no effect here).
    //   2. Set scrollY=700 AFTER initial render (the "/" PUSH effect already ran).
    //   3. Install window.rAF stub + clamping scrollTo stub.
    //   4. PUSH to post — "/" cleanup saves scrollY=700.
    //   5. Reset to short document + scrollY=0, clear rafQueue.
    //   6. POP — drives the rAF poll loop manually, verifying clamping.
    //
    // -------------------------------------------------------------------------

    // --- Step 1: Render with default spies (no rAF stub yet) -----------------
    let navigateRef: ((delta: number) => void) | null = null

    function BackNavigatorPage() {
      const navigate = useNavigate()
      navigateRef = (delta: number) => navigate(delta)
      return <div>post page</div>
    }

    const { container } = render(
      <MemoryRouter initialEntries={['/', '/post/base-1']} initialIndex={0}>
        <ScrollManager />
        <Routes>
          <Route path="/" element={<NavigatorPage to="/post/base-1" label="go to post" />} />
          <Route path="/post/base-1" element={<BackNavigatorPage />} />
        </Routes>
      </MemoryRouter>,
    )

    // Initial "/" PUSH effect has run (scrollTo(0,0) called, no rAF).

    // --- Step 2: Set scrollY=700 to prime the saved position -----------------
    Object.defineProperty(window, 'scrollY', { value: 700, writable: true, configurable: true })

    // --- Step 3: Install controllable rAF stub + clamping scrollTo stub ------

    type RafCallback = FrameRequestCallback
    const rafQueue: Array<{ id: number; cb: RafCallback }> = []
    let rafIdCounter = 0

    const origWindowRaf = window.requestAnimationFrame
    const origWindowCaf = window.cancelAnimationFrame

    Object.defineProperty(window, 'requestAnimationFrame', {
      value: (cb: RafCallback): number => {
        rafIdCounter += 1
        rafQueue.push({ id: rafIdCounter, cb })
        return rafIdCounter
      },
      writable: true,
      configurable: true,
    })

    Object.defineProperty(window, 'cancelAnimationFrame', {
      value: (id: number): void => {
        const idx = rafQueue.findIndex((entry) => entry.id === id)
        if (idx !== -1) rafQueue.splice(idx, 1)
      },
      writable: true,
      configurable: true,
    })

    /** Flush the oldest N pending rAF callbacks (count fixed at call time). */
    function flushRafs(n?: number): void {
      const count = n !== undefined ? Math.min(n, rafQueue.length) : rafQueue.length
      for (let i = 0; i < count; i++) {
        const entry = rafQueue.shift()
        if (entry !== undefined) {
          entry.cb(performance.now())
        }
      }
    }

    // Restore the no-op spy and install a clamping stub.
    scrollToSpy.mockRestore()

    let fakeScrollY = 700
    let fakeScrollHeight = 10802 // tall for the PUSH phase (700 reachable)

    Object.defineProperty(window, 'scrollY', {
      get: () => fakeScrollY,
      configurable: true,
    })
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      get: () => fakeScrollHeight,
      configurable: true,
    })
    Object.defineProperty(window, 'innerHeight', {
      value: 768,
      writable: true,
      configurable: true,
    })

    scrollToSpy = spyOn(window, 'scrollTo').mockImplementation(
      ((_x: number, y: number): void => {
        const maxScroll = Math.max(0, fakeScrollHeight - (window.innerHeight ?? 768))
        fakeScrollY = Math.min(Math.max(0, y), maxScroll)
      }) as typeof window.scrollTo,
    )

    // --- Step 4: PUSH to post — "/" cleanup saves fakeScrollY=700 -----------
    await act(async () => {
      within(container).getByText('go to post').click()
    })

    // Verify the "/" key got the right value (700 was reachable → saved=700).
    // The PUSH to "/post" calls scrollTo(0,0) → fakeScrollY=0 now.
    // Cleanup of "/" ran BEFORE that, saving 700. Good.

    // --- Step 5: Reset to SHORT document + scrollY=0 -------------------------
    fakeScrollY = 0
    fakeScrollHeight = 300  // short — target 700 unreachable (maxScroll = 0)
    scrollToSpy.mockClear()
    rafQueue.length = 0

    // --- Step 6: POP — ScrollManager queues the first rAF tick ---------------
    await act(async () => {
      navigateRef!(-1)
    })

    // The POP effect reads saved=700 from Map, calls window.requestAnimationFrame(poll).
    // act() does NOT intercept window.rAF — should be in our queue.
    expect(rafQueue.length).toBeGreaterThan(0)

    // --- Phase 1: short document — target clamped to 0 -----------------------
    // maxScroll = max(0, 300-768) = 0 → scrollTo(0,700) clamps fakeScrollY to 0.
    flushRafs(2)
    expect(fakeScrollY).not.toBe(700)

    // --- Phase 2: document grows — target now reachable ----------------------
    fakeScrollHeight = 11000  // maxScroll = 11000-768 = 10232 >> 700

    flushRafs(3)
    expect(fakeScrollY).toBe(700)

    // Loop stopped: no more rAF frames queued.
    expect(rafQueue.length).toBe(0)

    // --- Restore ---------------------------------------------------------------
    Object.defineProperty(window, 'requestAnimationFrame', {
      value: origWindowRaf,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(window, 'cancelAnimationFrame', {
      value: origWindowCaf,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true })
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 768,
      writable: true,
      configurable: true,
    })
  })
})
