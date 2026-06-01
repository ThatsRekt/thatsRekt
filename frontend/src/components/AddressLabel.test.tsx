/**
 * Tests for AddressLabel contributor-name resolution (issue #151 change 3).
 *
 * AddressLabel must:
 *   1. Display the contributor name for a known address (JerryTheKid.eth's Relayer).
 *   2. Copy aria-label references the raw hex address so copy still operates on hex.
 *   3. Lookup is case-insensitive.
 *   4. Unknown address falls back to short hex (no contributor label).
 */
import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Stub useEnsLookup before importing AddressLabel so wagmi never boots.
mock.module('../hooks/useEnsLookup', () => ({
  useEnsLookup: () => ({ name: null, isLoading: false }),
}))

// AddressLabel import AFTER the mock so it picks up the stub.
const { AddressLabel } = await import('./AddressLabel')

const JERRY_ADDR = '0xe0396d6d738e726d39f96099b8f6a55d11184374'
const JERRY_NAME = "JerryTheKid.eth's Relayer"

function renderLabel(props: { addr: string; chainSlug?: string; full?: boolean; ens?: boolean }) {
  return render(
    <MemoryRouter>
      <AddressLabel {...props} />
    </MemoryRouter>,
  )
}

describe('AddressLabel — contributor name resolution', () => {
  it("displays JerryTheKid.eth's Relayer for the known guardian address", () => {
    const { container } = renderLabel({ addr: JERRY_ADDR })
    expect(container.textContent).toContain(JERRY_NAME)
  })

  it('copy aria-label references the raw hex address', () => {
    renderLabel({ addr: JERRY_ADDR })
    // aria-label on the primary tappable button must reference the raw
    // address so screen readers speak the actual address regardless of
    // the display name. The secondary copy icon button has a generic label.
    const copyBtns = screen.getAllByRole('button', {
      name: new RegExp(`copy address ${JERRY_ADDR}`, 'i'),
    })
    expect(copyBtns.length).toBeGreaterThan(0)
  })

  it('lookup is case-insensitive — uppercase input resolves same name', () => {
    const { container } = renderLabel({ addr: JERRY_ADDR.toUpperCase() })
    expect(container.textContent).toContain(JERRY_NAME)
  })

  it('unknown address does NOT show a contributor name', () => {
    const unknown = '0x1234567890abcdef1234567890abcdef12345678'
    const { container } = renderLabel({ addr: unknown })
    expect(container.textContent).not.toContain(JERRY_NAME)
  })
})
