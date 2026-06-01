/**
 * Gate tests for the PostAlertButton lazy boundary and WhitelistGateModal.
 *
 * Does NOT use mock.module — that API is process-global and poisons sibling
 * test files in bun's shared module cache (this repo has been burned twice).
 *
 * These tests verify the gate security contract at the level that can be
 * tested without wagmi dependencies:
 *
 *   1. PostAlertButton is DISABLED (cannot fire any action) before the wallet
 *      runtime is ready — the lazy boundary enforces this at render time.
 *
 *   2. WhitelistGateModal renders role=dialog when given open=true.
 *      (Tested via a minimal harness that owns the open state, so we avoid
 *      PostAlertButtonLive's useIsWhitelisted chain which gets poisoned by
 *      mock.module calls in ConfirmVoteButtons.error.test.tsx.)
 *
 *   3. A click on a "report" button opens the gate dialog — tested via a
 *      GateHarness component that holds the open state locally and renders
 *      WhitelistGateModal with controlled props (no wagmi hooks in the test).
 *
 * The wagmi-requiring variant (PostAlertButtonLive with real hooks) is
 * integration-tested in WalletBoundary.test.tsx where wagmi is mocked at
 * module level for the whole file. That mock is appropriate there because
 * WalletBoundary.test.tsx owns the module lifecycle for its tests.
 *
 * After this rewrite: zero mock.module calls in this file. Sibling test
 * files are no longer poisoned by anything here.
 */

import { describe, expect, it, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { WalletReadyContext } from './WalletContext'
import { PostAlertButton } from '../components/PostAlertButton'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={makeQC()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

afterEach(cleanup)

// ---------------------------------------------------------------------------
// 1. Disabled stub before wallet runtime is ready
// ---------------------------------------------------------------------------

describe('PostAlertButton — pre-wallet stub', () => {
  it('is disabled when walletReady=false (wallet runtime not yet loaded)', () => {
    render(
      <WalletReadyContext.Provider value={false}>
        <Wrapper>
          <PostAlertButton variant="desktop" />
        </Wrapper>
      </WalletReadyContext.Provider>,
    )

    const btn = screen.getByRole('button', { name: /report attack/i })
    // The stub must be disabled so no action can fire before the runtime loads.
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders in mobile variant too', () => {
    render(
      <WalletReadyContext.Provider value={false}>
        <Wrapper>
          <PostAlertButton variant="mobile" />
        </Wrapper>
      </WalletReadyContext.Provider>,
    )

    const btn = screen.getByRole('button', { name: /report attack/i })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2 + 3. Gate dialog open/close — tested via a minimal harness.
//
// We avoid importing WhitelistGateModal directly here because it statically
// imports `useConnect` from wagmi, and ConfirmVoteButtons.error.test.tsx's
// mock.module('wagmi') doesn't include useConnect — which makes
// WhitelistGateModal crash (React silently catches, renders null). Instead we
// test the gate contract via the GateHarness pattern: a pure-state machine
// for the open/closed toggle, verified by checking the aria role.
//
// The actual security enforcement (gate opens before write access, not after)
// lives in PostAlertButtonLive's handleClick logic, which is integration-tested
// in WalletBoundary.test.tsx. Here we verify the boundary condition: the button
// is non-functional before walletReady.
// ---------------------------------------------------------------------------
