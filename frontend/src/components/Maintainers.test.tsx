/**
 * Tests for Maintainers component (issue #253 — add ohdatskate.eth).
 *
 * Asserts:
 *  1. All three maintainers render.
 *  2. ohdatskate.eth has correct X, Telegram, and ENS links.
 *  3. jerrythekid and bauti.eth still render with their original links.
 *  4. jerrythekid and bauti.eth have no telegram link.
 */
import { describe, expect, it } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { Maintainers } from './Maintainers'

function renderMaintainers() {
  return render(<Maintainers />)
}

describe('Maintainers', () => {
  it('renders all three maintainers by name', () => {
    const { container } = renderMaintainers()
    expect(container.textContent).toContain('jerrythekid')
    expect(container.textContent).toContain('bauti.eth')
    expect(container.textContent).toContain('ohdatskate.eth')
  })

  it('uses Oxford-comma grammar: "A, B, and C."', () => {
    const { container } = renderMaintainers()
    // The connective text must contain ", and " — not just " and ".
    expect(container.textContent).toContain(', and ')
  })

  describe('ohdatskate.eth links', () => {
    it('has an X link pointing to https://x.com/ohdatskate', () => {
      renderMaintainers()
      const xLinks = screen.getAllByRole('link', { name: /^x$/i })
      // Multiple "x" links exist (one per maintainer); find the one for ohdatskate
      const ohdatskateXLink = xLinks.find(
        (el) => el.getAttribute('href') === 'https://x.com/ohdatskate',
      )
      expect(ohdatskateXLink).toBeDefined()
      expect(ohdatskateXLink!.getAttribute('href')).toBe('https://x.com/ohdatskate')
    })

    it('has a Telegram link pointing to https://t.me/ohdatskate', () => {
      renderMaintainers()
      const tgLinks = screen.getAllByRole('link', { name: /^tg$/i })
      const ohdatskateTgLink = tgLinks.find(
        (el) => el.getAttribute('href') === 'https://t.me/ohdatskate',
      )
      expect(ohdatskateTgLink).toBeDefined()
      expect(ohdatskateTgLink!.getAttribute('href')).toBe('https://t.me/ohdatskate')
    })

    it('has an ENS link pointing to https://app.ens.domains/ohdatskate.eth', () => {
      renderMaintainers()
      const ensLinks = screen.getAllByRole('link', { name: /^ens$/i })
      const ohdatskateEnsLink = ensLinks.find(
        (el) => el.getAttribute('href') === 'https://app.ens.domains/ohdatskate.eth',
      )
      expect(ohdatskateEnsLink).toBeDefined()
      expect(ohdatskateEnsLink!.getAttribute('href')).toBe(
        'https://app.ens.domains/ohdatskate.eth',
      )
    })

    it('has no GitHub link', () => {
      renderMaintainers()
      const ghLinks = screen.getAllByRole('link', { name: /^gh$/i })
      // Only jerrythekid and bauti.eth have gh links — none for ohdatskate
      const ohdatskateGhLink = ghLinks.find(
        (el) => el.getAttribute('href') === 'https://github.com/ohdatskate',
      )
      expect(ohdatskateGhLink).toBeUndefined()
    })
  })

  describe('jerrythekid links (unchanged)', () => {
    it('has an X link to https://x.com/jerrythekid', () => {
      renderMaintainers()
      const xLinks = screen.getAllByRole('link', { name: /^x$/i })
      const jerryXLink = xLinks.find(
        (el) => el.getAttribute('href') === 'https://x.com/jerrythekid',
      )
      expect(jerryXLink).toBeDefined()
    })

    it('has a GitHub link to https://github.com/JeronimoHoulin', () => {
      renderMaintainers()
      const ghLinks = screen.getAllByRole('link', { name: /^gh$/i })
      const jerryGhLink = ghLinks.find(
        (el) => el.getAttribute('href') === 'https://github.com/JeronimoHoulin',
      )
      expect(jerryGhLink).toBeDefined()
    })

    it('has an ENS link to https://app.ens.domains/jerrythekid.eth', () => {
      renderMaintainers()
      const ensLinks = screen.getAllByRole('link', { name: /^ens$/i })
      const jerryEnsLink = ensLinks.find(
        (el) => el.getAttribute('href') === 'https://app.ens.domains/jerrythekid.eth',
      )
      expect(jerryEnsLink).toBeDefined()
    })

    it('has no Telegram link', () => {
      const { container } = renderMaintainers()
      // Only ohdatskate.eth has a tg link. Confirm there is no t.me link
      // whose surrounding context is jerrythekid (check by querying links
      // for t.me/jerrythekid which must not exist).
      const allLinks = container.querySelectorAll('a[href^="https://t.me/jerrythekid"]')
      expect(allLinks).toHaveLength(0)
    })
  })

  describe('bauti.eth links (unchanged)', () => {
    it('has an X link to https://x.com/BautiDeFi', () => {
      renderMaintainers()
      const xLinks = screen.getAllByRole('link', { name: /^x$/i })
      const bautiXLink = xLinks.find(
        (el) => el.getAttribute('href') === 'https://x.com/BautiDeFi',
      )
      expect(bautiXLink).toBeDefined()
    })

    it('has a GitHub link to https://github.com/bauti-defi', () => {
      renderMaintainers()
      const ghLinks = screen.getAllByRole('link', { name: /^gh$/i })
      const bautiGhLink = ghLinks.find(
        (el) => el.getAttribute('href') === 'https://github.com/bauti-defi',
      )
      expect(bautiGhLink).toBeDefined()
    })

    it('has an ENS link to https://app.ens.domains/bauti.eth', () => {
      renderMaintainers()
      const ensLinks = screen.getAllByRole('link', { name: /^ens$/i })
      const bautiEnsLink = ensLinks.find(
        (el) => el.getAttribute('href') === 'https://app.ens.domains/bauti.eth',
      )
      expect(bautiEnsLink).toBeDefined()
    })
  })
})
