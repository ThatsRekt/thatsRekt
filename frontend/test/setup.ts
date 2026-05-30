/**
 * Bun test preload for React component tests.
 *
 * Sets up a happy-dom browser environment by copying the GlobalWindow
 * properties onto the bun global scope, so that React rendering,
 * DOM assertions, and @testing-library/react work within bun:test.
 * Referenced from bunfig.toml [test] preload.
 */
import { GlobalWindow } from 'happy-dom'

const window = new GlobalWindow()

// Hoist DOM globals into bun's global scope so React and testing-library
// find what they expect (document, window, HTMLElement, etc.).
Object.defineProperty(globalThis, 'window', { value: window, writable: true })
Object.defineProperty(globalThis, 'document', { value: window.document, writable: true })
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, writable: true })
Object.defineProperty(globalThis, 'location', { value: window.location, writable: true })
Object.defineProperty(globalThis, 'history', { value: window.history, writable: true })
Object.defineProperty(globalThis, 'HTMLElement', { value: window.HTMLElement, writable: true })
Object.defineProperty(globalThis, 'Element', { value: window.Element, writable: true })
Object.defineProperty(globalThis, 'Node', { value: window.Node, writable: true })
Object.defineProperty(globalThis, 'Event', { value: window.Event, writable: true })
Object.defineProperty(globalThis, 'CustomEvent', { value: window.CustomEvent, writable: true })
Object.defineProperty(globalThis, 'MouseEvent', { value: window.MouseEvent, writable: true })

// requestAnimationFrame / cancelAnimationFrame — happy-dom exposes these on
// its window object. Hoist them so components that call rAF in effects work
// under bun:test without a ReferenceError.
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    writable: true,
  })
}
if (typeof globalThis.cancelAnimationFrame === 'undefined') {
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    value: (id: number) => clearTimeout(id),
    writable: true,
  })
}

// Cloudflare Turnstile widget stub for component tests.
//
// The real widget is a CDN-injected browser global: window.turnstile.render(container, opts)
// calls opts.callback(token) asynchronously once the CAPTCHA is solved. In
// test environments the CDN script never loads, so window.turnstile is
// undefined and opts.callback is never called, leaving turnstileToken === ''.
//
// This stub fires opts.callback synchronously with the Cloudflare documented
// always-pass test token (1x00000000000000000000AA) so that tests which render
// TurnstileWidget receive a non-empty token without any network calls. Stub
// also implements reset/remove as no-ops so the widget lifecycle is clean.
//
// This is a browser-API-level stub (equivalent to mocking requestAnimationFrame),
// not an infra boundary mock.
const TURNSTILE_TEST_TOKEN = '1x00000000000000000000AA'
let widgetCounter = 0

Object.defineProperty(globalThis, 'turnstile', {
  value: {
    render: (
      _container: HTMLElement,
      opts: { callback: (token: string) => void; 'expired-callback'?: () => void; 'error-callback'?: () => void },
    ): string => {
      const id = String(++widgetCounter)
      // Fire synchronously so the token is set before any awaited user-event.
      opts.callback(TURNSTILE_TEST_TOKEN)
      return id
    },
    reset: (_id: string): void => {},
    remove: (_id: string): void => {},
  },
  writable: true,
})

// Also expose on window so ApplyForm's `window.turnstile` check sees it.
;(window as unknown as Record<string, unknown>)['turnstile'] = (globalThis as unknown as Record<string, unknown>)['turnstile']
