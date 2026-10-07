import { describe, expect, it, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ComingInV2 } from './ComingInV2'
import { slugify } from './DocsTOC'
import {
  V2_DOCS_HEADING,
  V2_DOCS_SECTION_ID,
  V2_FEED_HREF,
} from '../lib/v2Announcement'

afterEach(() => {
  cleanup()
})

function renderSection() {
  return render(
    <MemoryRouter>
      <ComingInV2 />
    </MemoryRouter>,
  )
}

describe('ComingInV2', () => {
  it('lists the features the v2 design actually promises', () => {
    renderSection()
    expect(screen.getByText('Gasless')).toBeDefined()
    expect(screen.getByText(/v2 is going gasless/i)).toBeDefined()
    expect(screen.getByText(/the new API takes the report/i)).toBeDefined()
    expect(screen.queryByText(/signature/i)).toBeNull()
    expect(screen.getByText('AI-powered')).toBeDefined()
    expect(screen.getByText(/latest AI models/i)).toBeDefined()
    expect(screen.getByText('Channels')).toBeDefined()
    expect(screen.getByText(/own channel/i)).toBeDefined()
    expect(screen.getByText('A status for every post')).toBeDefined()
    expect(screen.getByText(/the API shows where each post is/i)).toBeDefined()
    expect(screen.getAllByText(/edits go through the API/i).length).toBeGreaterThan(0)
    expect(screen.getByText('Same address for integrators')).toBeDefined()
  })

  it('says the new API carries reports, edits, and everything else', () => {
    renderSection()
    expect(screen.getByText(/starting October 26, 2026/i)).toBeDefined()
    expect(screen.getByText(/reports go through the API, edits go through the API/i)).toBeDefined()
    expect(screen.getByText(/nothing here is live yet/i)).toBeDefined()
  })

  it('links back to the feed announcement', () => {
    renderSection()
    const link = screen.getByRole('link', { name: /announced on the feed/i })
    expect(link.getAttribute('href')).toBe(V2_FEED_HREF)
    expect(link.getAttribute('href')).toBe('/#v2-announcement')
  })

  it('uses the heading id the feed banner and the TOC both target', () => {
    const { container } = renderSection()
    expect(slugify(V2_DOCS_HEADING)).toBe(V2_DOCS_SECTION_ID)
    expect(container.querySelector('section')?.id).toBe('coming-in-v2')
  })
})
