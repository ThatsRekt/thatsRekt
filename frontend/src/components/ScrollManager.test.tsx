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
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { render, act, cleanup, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { ScrollManager } from './ScrollManager'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let scrollToSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  // Spy on window.scrollTo before each test.
  // happy-dom attaches scrollTo to the window; spyOn lets us track calls.
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
    // Mount on "/" — the initial render is a PUSH
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
    // then pressed back. ScrollManager should restore 400 on the POP.
    //
    // Approach: mount with entries ["/", "/post/base-1"] so the second
    // entry is active (index 1). Then trigger a back navigation (POP).
    // Before that, we need to prime the saved position map.
    //
    // Because the Map is internal to the component we cannot inject it
    // directly. Instead we:
    //   1. Mount with "/" as the initial route.
    //   2. Navigate to "/post/base-1" (PUSH — ScrollManager saves "/" key).
    //      We fake window.scrollY = 400 before the save fires (cleanup).
    //   3. Navigate back (POP) — ScrollManager should restore 400.
    //
    // The save happens in the effect cleanup of the previous location
    // (i.e., when the location changes away from "/"), so we set
    // window.scrollY *after* the initial render and *before* navigating.

    // happy-dom supports scrollY as a getter; override it to control the value.
    Object.defineProperty(window, 'scrollY', { value: 400, writable: true, configurable: true })

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
          <Route
            path="/"
            element={
              <NavigatorPage to="/post/base-1" label="go to post" />
            }
          />
          <Route path="/post/base-1" element={<BackNavigatorPage />} />
        </Routes>
      </MemoryRouter>,
    )

    // Navigate to post (PUSH) — cleanup of "/" will save scrollY=400
    await act(async () => {
      within(container).getByText('go to post').click()
    })

    scrollToSpy.mockClear()

    // Reset scrollY to 0 (simulating the post page top)
    Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true })

    // Navigate back (POP)
    await act(async () => {
      navigateRef!(-1)
    })

    // Should restore the saved 400
    expect(scrollToSpy).toHaveBeenCalledWith(0, 400)
  })

  it('scrolls to top (fallback) on POP when no position was saved', async () => {
    // Navigate forward and back without a pre-existing saved position.
    // This covers a cold deep-link → back scenario.
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

    // Navigate forward — use container-scoped query to avoid cross-test DOM interference
    await act(async () => {
      within(container).getByText('go to post').click()
    })

    scrollToSpy.mockClear()

    // Navigate back — no saved position for '/other' after a cold start
    await act(async () => {
      navigateRef!(-1)
    })

    // Falls back to top
    expect(scrollToSpy).toHaveBeenCalledWith(0, 0)
  })
})
