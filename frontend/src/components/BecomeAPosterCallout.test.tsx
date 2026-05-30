/**
 * Tests for BecomeAPosterCallout — issue #176:
 *   Both variants (card, inline) must route to /apply,
 *   NOT a mailto: href.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BecomeAPosterCallout } from './BecomeAPosterCallout'

afterEach(() => {
  cleanup()
})

function renderCallout(variant?: 'card' | 'inline') {
  return render(
    <MemoryRouter>
      <BecomeAPosterCallout variant={variant} />
    </MemoryRouter>,
  )
}

describe('BecomeAPosterCallout — apply CTA (#176)', () => {
  it('card variant: apply CTA href is /apply', () => {
    const { container } = renderCallout('card')
    const anchors = container.querySelectorAll('a')
    const applyLink = Array.from(anchors).find((a) =>
      /apply/i.test(a.textContent ?? ''),
    )
    expect(applyLink).toBeDefined()
    expect(applyLink?.getAttribute('href')).toBe('/apply')
  })

  it('inline variant: apply CTA href is /apply', () => {
    const { container } = renderCallout('inline')
    const link = screen.getByText(/apply to guard/i).closest('a')
    expect(link?.getAttribute('href')).toBe('/apply')
  })

  it('card variant: no mailto:thatsrekt@protonmail in DOM', () => {
    const { container } = renderCallout('card')
    const anchors = container.querySelectorAll('a[href^="mailto:thatsrekt@protonmail"]')
    expect(anchors.length).toBe(0)
  })

  it('inline variant: no mailto:thatsrekt@protonmail in DOM', () => {
    const { container } = renderCallout('inline')
    const anchors = container.querySelectorAll('a[href^="mailto:thatsrekt@protonmail"]')
    expect(anchors.length).toBe(0)
  })
})
