/**
 * Tests for FeedTLDR — issue #176:
 *   The "apply as guardian" CTA must route to /apply (internal Link),
 *   NOT a mailto: href. The "join alerts" CTA (external Telegram link)
 *   must remain unchanged.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { FeedTLDR } from './FeedTLDR'

afterEach(() => {
  cleanup()
})

function renderTLDR() {
  // Ensure localStorage flag is not set so the component renders.
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('thatsrekt_tldr_dismissed_v1')
  }
  return render(
    <MemoryRouter>
      <FeedTLDR />
    </MemoryRouter>,
  )
}

describe('FeedTLDR — apply CTA (#176)', () => {
  it('renders the "apply as guardian" CTA', () => {
    renderTLDR()
    const link = screen.getByRole('link', { name: /apply.*guardian/i })
    expect(link).toBeDefined()
  })

  it('apply CTA href is /apply (not a mailto)', () => {
    renderTLDR()
    const link = screen.getByRole('link', { name: /apply.*guardian/i })
    expect(link.getAttribute('href')).toBe('/apply')
  })

  it('no mailto:thatsrekt@protonmail in the rendered DOM', () => {
    const { container } = renderTLDR()
    const anchors = container.querySelectorAll('a[href^="mailto:thatsrekt@protonmail"]')
    expect(anchors.length).toBe(0)
  })

  it('join alerts link still points to the Telegram channel (external)', () => {
    renderTLDR()
    // aria-label is "join the thatsRekt telegram alerts channel"
    const link = screen.getByRole('link', { name: /telegram alerts channel/i })
    expect(link.getAttribute('href')).toContain('t.me')
  })
})
