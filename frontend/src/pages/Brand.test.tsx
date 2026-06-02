/**
 * Tests for the Brand page (`/brand`) — the public brand kit.
 *
 * The page is a static reference surface assembled from the existing
 * design system. These tests pin the contract that matters to people
 * who actually use the kit:
 *   - the page renders its headline + the major sections,
 *   - the live mark is shown,
 *   - the brand colors are present as copyable hex values,
 *   - every download points at a real, downloadable asset file.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Brand } from './Brand'

afterEach(() => {
  cleanup()
})

function renderBrand() {
  return render(
    <MemoryRouter>
      <Brand />
    </MemoryRouter>,
  )
}

describe('Brand page — structure', () => {
  it('renders the "brand kit" headline', () => {
    renderBrand()
    expect(screen.getByRole('heading', { name: /brand kit/i, level: 1 })).toBeDefined()
  })

  it('renders the standard-kit section headings', () => {
    renderBrand()
    expect(screen.getByRole('heading', { name: /the mark/i })).toBeDefined()
    expect(screen.getByRole('heading', { name: /wordmark/i })).toBeDefined()
    expect(screen.getByRole('heading', { name: /colors/i })).toBeDefined()
    expect(screen.getByRole('heading', { name: /typography/i })).toBeDefined()
    expect(screen.getByRole('heading', { name: /voice/i })).toBeDefined()
    expect(screen.getByRole('heading', { name: /downloads/i })).toBeDefined()
  })
})

describe('Brand page — the mark', () => {
  it('displays the live logo mark from /logo.png', () => {
    const { container } = renderBrand()
    const mark = container.querySelector('img[src="/logo.png"]')
    expect(mark).not.toBeNull()
  })
})

describe('Brand page — colors', () => {
  // The brutalist palette derived from index.css + tailwind usage.
  const PALETTE = ['#f5f4ee', '#0a0a0a', '#000000', '#dc2626', '#fef08a']

  for (const hex of PALETTE) {
    it(`surfaces the ${hex} swatch as copyable text`, () => {
      renderBrand()
      // CopyableText renders the value as visible (and copyable) text.
      expect(screen.getAllByText(hex).length).toBeGreaterThan(0)
    })
  }
})

describe('Brand page — downloads', () => {
  // href -> must be a real file served from frontend/public.
  // Assets live at the web ROOT (not under /brand) so the physical asset
  // path can't shadow the /brand SPA route — a directory named `brand`
  // makes nginx 301 /brand → /brand/ → 403 instead of serving index.html.
  const DOWNLOADS = [
    '/logo.png',
    '/favicon.svg',
    '/og-image-default.png',
    '/thatsrekt-wordmark.svg',
  ]

  for (const href of DOWNLOADS) {
    it(`offers a download anchor for ${href}`, () => {
      const { container } = renderBrand()
      const anchor = container.querySelector(`a[href="${href}"]`)
      expect(anchor).not.toBeNull()
      // Brand assets should download, not navigate.
      expect(anchor?.hasAttribute('download')).toBe(true)
    })
  }
})
