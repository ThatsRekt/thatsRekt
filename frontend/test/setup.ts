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
