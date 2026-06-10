/**
 * Tests for Footer — issue #176:
 *   "apply to guard" CTA must route to /apply (internal Link),
 *   NOT a mailto: href.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Footer } from './Footer'

afterEach(() => {
  cleanup()
})

function renderFooter() {
  return render(
    <MemoryRouter>
      <Footer />
    </MemoryRouter>,
  )
}

describe('Footer — apply CTA (#176)', () => {
  it('renders the "apply to guard" link', () => {
    renderFooter()
    const link = screen.getByText(/apply to guard/i)
    expect(link).toBeDefined()
  })

  it('apply CTA href is /apply (not a mailto)', () => {
    renderFooter()
    const link = screen.getByText(/apply to guard/i).closest('a')
    expect(link).toBeDefined()
    expect(link?.getAttribute('href')).toBe('/apply')
  })

  it('no mailto:thatsrekt@protonmail in the rendered DOM', () => {
    const { container } = renderFooter()
    const anchors = container.querySelectorAll('a[href^="mailto:thatsrekt@protonmail"]')
    expect(anchors.length).toBe(0)
  })
})

describe('Footer — brand kit link', () => {
  it('links to the /brand kit page', () => {
    const { container } = renderFooter()
    const link = container.querySelector('a[href="/brand"]')
    expect(link).not.toBeNull()
    expect(link?.textContent?.toLowerCase()).toContain('brand')
  })
})
