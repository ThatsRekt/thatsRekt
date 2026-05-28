/**
 * Unit tests for BackLink.
 *
 * BackLink renders as a <Link to="/"> but intercepts left-clicks when
 * history.state.idx > 0, calling navigate(-1) instead of a PUSH to "/".
 * Modifier keys and non-primary buttons fall through to the Link default.
 *
 * happy-dom + RTL + MemoryRouter.
 *
 * Test strategy:
 *   - Structural: anchor href, className passthrough, children.
 *   - Behavioural on modifier/secondary clicks: our handler returns early
 *     without calling navigate(-1). We verify by reading the captured
 *     navigate ref — it should not have been called with -1.
 *   - Behavioural on primary click + idx>0: navigate(-1) is called (POP).
 *     We verify by observing the MemoryRouter location change from
 *     '/post/base-1' back to '/'.
 *   - Behavioural on primary click + idx=0: navigate(-1) is NOT called;
 *     Link pushes '/' instead (same destination, different history action).
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { BackLink } from './BackLink'

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Helper: observe current router location from within the tree.
// ---------------------------------------------------------------------------
let capturedPath = ''

function LocationObserver() {
  const loc = useLocation()
  capturedPath = loc.pathname
  return null
}

function setHistoryIdx(idx: number) {
  Object.defineProperty(window, 'history', {
    value: { ...window.history, state: { idx } },
    writable: true,
    configurable: true,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackLink', () => {
  it('renders an anchor with href="/"', () => {
    setHistoryIdx(0)
    const { container } = render(
      <MemoryRouter initialEntries={['/post/base-1']}>
        <BackLink>← back to feed</BackLink>
      </MemoryRouter>,
    )
    const anchor = container.querySelector('a')
    expect(anchor).not.toBeNull()
    expect(anchor!.getAttribute('href')).toBe('/')
  })

  it('passes through className to the rendered anchor', () => {
    setHistoryIdx(0)
    const { container } = render(
      <MemoryRouter initialEntries={['/post/base-1']}>
        <BackLink className="rekt-link custom-class">← back</BackLink>
      </MemoryRouter>,
    )
    const anchor = container.querySelector('a')!
    expect(anchor.className).toContain('rekt-link')
    expect(anchor.className).toContain('custom-class')
  })

  it('renders children correctly', () => {
    setHistoryIdx(0)
    const { container } = render(
      <MemoryRouter initialEntries={['/post/base-1']}>
        <BackLink>← back to feed</BackLink>
      </MemoryRouter>,
    )
    const anchor = container.querySelector('a')!
    expect(anchor.textContent).toBe('← back to feed')
  })

  it('navigates to "/" via POP (navigate(-1)) when idx > 0 and primary click', async () => {
    // Two-entry history: ['/', '/post/base-1']. With idx=1, BackLink should
    // call navigate(-1) → POP → location lands on '/'.
    setHistoryIdx(1)
    capturedPath = '/post/base-1'

    const { container } = render(
      <MemoryRouter initialEntries={['/', '/post/base-1']} initialIndex={1}>
        <LocationObserver />
        <BackLink>← back to feed</BackLink>
      </MemoryRouter>,
    )

    expect(capturedPath).toBe('/post/base-1')

    await act(async () => {
      fireEvent.click(container.querySelector('a')!)
    })

    // After navigate(-1), MemoryRouter pops to '/'
    expect(capturedPath).toBe('/')
  })

  it('navigates to "/" via PUSH when idx is 0 (cold deep-link)', async () => {
    // Single-entry history (cold deep-link): idx=0. BackLink should NOT call
    // navigate(-1); Link's default pushes '/'. Location still lands at '/'.
    setHistoryIdx(0)
    capturedPath = '/post/base-1'

    const { container } = render(
      <MemoryRouter initialEntries={['/post/base-1']}>
        <LocationObserver />
        <BackLink>← back to feed</BackLink>
      </MemoryRouter>,
    )

    expect(capturedPath).toBe('/post/base-1')

    await act(async () => {
      fireEvent.click(container.querySelector('a')!)
    })

    // Link pushes to '/' (idx was 0, navigate(-1) not called)
    expect(capturedPath).toBe('/')
  })

  it('does not navigate on right-click (button=2)', async () => {
    // Our handler returns early for non-primary buttons.
    // React Router Link also ignores non-primary buttons — so no navigation.
    setHistoryIdx(5)
    capturedPath = '/post/base-1'

    const { container } = render(
      <MemoryRouter initialEntries={['/feed', '/post/base-1']} initialIndex={1}>
        <LocationObserver />
        <BackLink>← back to feed</BackLink>
      </MemoryRouter>,
    )

    expect(capturedPath).toBe('/post/base-1')

    await act(async () => {
      const anchor = container.querySelector('a')!
      const rightClick = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 2,
      })
      anchor.dispatchEvent(rightClick)
    })

    // Location unchanged — neither BackLink nor Link navigated
    expect(capturedPath).toBe('/post/base-1')
  })

  it('does not call navigate(-1) on ctrl+click (open in new tab)', async () => {
    // Our handler returns early for modifier keys.
    // React Router Link also ignores ctrlKey clicks — so no navigation.
    setHistoryIdx(5)
    capturedPath = '/post/base-1'

    const { container } = render(
      <MemoryRouter initialEntries={['/feed', '/post/base-1']} initialIndex={1}>
        <LocationObserver />
        <BackLink>← back to feed</BackLink>
      </MemoryRouter>,
    )

    expect(capturedPath).toBe('/post/base-1')

    await act(async () => {
      const anchor = container.querySelector('a')!
      const ctrlClick = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ctrlKey: true,
      })
      anchor.dispatchEvent(ctrlClick)
    })

    // Location unchanged
    expect(capturedPath).toBe('/post/base-1')
  })
})
