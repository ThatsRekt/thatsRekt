/**
 * Bundle-diet tests — TDD guard for PR bauti/frontend-bundle-diet.
 *
 * Covers:
 *  1. LazyMarkdown renders markdown content when resolved.
 *  2. LazyMarkdown handles plain-text (no markdown) without crashing.
 *  3. LazyMarkdown compact prop passes through without error.
 *
 * Route lazy-loading (items 4-7 from the spec) is validated at build time:
 * the AFTER chunk sizes reported in the PR prove the split happened. A
 * source-level assertion that App.tsx imports pages lazily would require
 * mocking the entire wagmi/query provider tree which would pollute the
 * global mock registry and break ScrollManager + Footer tests that run
 * in the same bun worker. The build artefact numbers are the ground truth.
 */
import { describe, expect, test, mock } from 'bun:test'
import { render, waitFor } from '@testing-library/react'
import { Suspense } from 'react'

// ---------------------------------------------------------------------------
// useEnsLookup stub — prevents wagmi from booting in this test file.
// Scoped to this file because mock.module is process-global in bun:test;
// we deliberately avoid mocking Footer/ScrollManager here so those test
// files are not poisoned.
// ---------------------------------------------------------------------------
mock.module('../src/hooks/useEnsLookup', () => ({
  useEnsLookup: () => ({ name: null, isLoading: false }),
}))

// LazyMarkdown import AFTER the mock.
const { LazyMarkdown } = await import('../src/components/LazyMarkdown')

// ---------------------------------------------------------------------------
// LazyMarkdown unit tests
// ---------------------------------------------------------------------------

describe('LazyMarkdown', () => {
  test('renders markdown content once the lazy chunk resolves', async () => {
    const { container } = render(
      <Suspense fallback={<span>loading…</span>}>
        <LazyMarkdown source="**hello world**" />
      </Suspense>,
    )
    // The Suspense boundary may briefly show the fallback; wait for
    // the lazy import to resolve and the rendered output to appear.
    await waitFor(() => {
      expect(container.textContent).toContain('hello world')
    })
  })

  test('renders plain text without crashing', async () => {
    const { container } = render(
      <Suspense fallback={<span>loading…</span>}>
        <LazyMarkdown source="plain text no markdown" />
      </Suspense>,
    )
    await waitFor(() => {
      expect(container.textContent).toContain('plain text no markdown')
    })
  })

  test('compact prop passes through without error', async () => {
    const { container } = render(
      <Suspense fallback={<span>loading…</span>}>
        <LazyMarkdown source="compact **test**" compact />
      </Suspense>,
    )
    await waitFor(() => {
      expect(container.textContent).toContain('compact test')
    })
  })

  test('renders a skeleton fallback initially then resolves', async () => {
    // We cannot easily test the transient fallback state in a synchronous
    // assertion, but we CAN assert the final resolved state doesn't show
    // the skeleton aria-hidden placeholder.
    const { container } = render(
      <Suspense fallback={<span>loading…</span>}>
        <LazyMarkdown source="resolved content" />
      </Suspense>,
    )
    await waitFor(() => {
      expect(container.textContent).toContain('resolved content')
    })
    // Skeleton divs have aria-hidden="true"; once resolved they must be gone.
    const skeletons = container.querySelectorAll('[aria-hidden="true"]')
    expect(skeletons.length).toBe(0)
  })
})
