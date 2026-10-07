import { useState } from 'react'
import { Link } from 'react-router-dom'
import { V2_ANNOUNCEMENT_ID, V2_DOCS_HREF } from '../lib/v2Announcement'

const STORAGE_KEY = 'thatsrekt_v2_announcement_dismissed_v1'

/**
 * Thin front-page notice, same strip as the demo-mode banner.
 * Dismiss persists so a refresh does not bring it back. Versioned
 * key so a real copy change can show it again.
 */
export function V2Announcement() {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })

  if (dismissed) return null

  const onDismiss = () => {
    setDismissed(true)
    try {
      window.localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      // Session state already hid it.
    }
  }

  return (
    <div
      id={V2_ANNOUNCEMENT_ID}
      aria-label="Version 2 announcement"
      className="relative mb-4 border-2 border-red-600 bg-red-50 px-3 py-2 pr-8 text-xs uppercase tracking-widest scroll-mt-6"
    >
      <span className="font-black text-red-600">v2</span>
      <span className="ml-2 text-neutral-700">
        in the works · more news soon · ships very soon
      </span>
      <Link to={V2_DOCS_HREF} className="ml-2 font-black rekt-link">
        what's coming →
      </Link>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="dismiss"
        className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center text-neutral-600 hover:text-black"
      >
        ✕
      </button>
    </div>
  )
}
