import { describe, expect, it, afterEach, beforeEach } from 'bun:test'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { V2Announcement } from './V2Announcement'
import { V2_ANNOUNCEMENT_ID, V2_DOCS_HREF } from '../lib/v2Announcement'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

function renderBanner() {
  return render(
    <MemoryRouter>
      <V2Announcement />
    </MemoryRouter>,
  )
}

describe('V2Announcement', () => {
  it('is a one-line notice that v2 is in the works and ships soon', () => {
    renderBanner()
    const banner = screen.getByLabelText('Version 2 announcement')
    expect(banner.textContent).toMatch(/v2/i)
    expect(banner.textContent).toMatch(/in the works/i)
    expect(banner.textContent).toMatch(/more news soon/i)
    expect(banner.textContent).toMatch(/ships very soon/i)
  })

  it('links to the docs section that lists what is coming', () => {
    renderBanner()
    const link = screen.getByRole('link', { name: /what's coming/i })
    expect(link.getAttribute('href')).toBe(V2_DOCS_HREF)
    expect(link.getAttribute('href')).toBe('/docs#coming-in-v2')
  })

  it('is the anchor the docs section links back to', () => {
    const { container } = renderBanner()
    expect(container.querySelector(`#${V2_ANNOUNCEMENT_ID}`)).toBeDefined()
  })

  it('hides when dismissed and stays hidden', () => {
    const first = renderBanner()
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }))
    expect(screen.queryByLabelText('Version 2 announcement')).toBeNull()
    first.unmount()

    renderBanner()
    expect(screen.queryByLabelText('Version 2 announcement')).toBeNull()
  })
})
