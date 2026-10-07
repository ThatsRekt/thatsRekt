import { useState } from 'react'
import { DAO_FUND_INITIATIVE_URL } from '../lib/daoFund'

const STORAGE_KEY = 'thatsrekt_dao_fund_banner_dismissed_v3'

/**
 * Thin front-page notice, same strip as the demo-mode banner.
 * Dismiss persists so a refresh does not bring it back.
 */
export function DaoFundBanner() {
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
      aria-label="The DAO Fund selection"
      className="relative mb-4 border-2 border-red-600 bg-red-50 px-3 py-2 pr-8 text-xs uppercase tracking-widest"
    >
      <span className="font-black text-red-600">the dao fund</span>
      <span className="ml-2 text-neutral-700">
        thatsRekt has been selected for The DAO Fund, an Ethereum security public-good funding program.
      </span>
      <a
        href={DAO_FUND_INITIATIVE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-2 font-black rekt-link"
      >
        See more →
      </a>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="dismiss dao fund banner"
        className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center text-neutral-600 hover:text-black"
      >
        ✕
      </button>
    </div>
  )
}
