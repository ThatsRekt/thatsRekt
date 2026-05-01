import { useState } from 'react'
import { Link } from 'react-router-dom'
import { TgChannelCTA } from './TgChannelCTA'

const STORAGE_KEY = 'thatsrekt_tldr_dismissed_v1'

/**
 * Top-of-feed orientation block for first-time visitors.
 *
 * Most newcomers land on `/` and see a list of brutalist post cards
 * with no preamble — there's no signal that this is an interactive
 * registry vs. a news site, who it's for, or what they can do with the
 * data. This block answers "what am I looking at" in three lines and
 * routes the curious to /about (story) or /docs (integration).
 *
 * Dismissible: clicking ✕ writes a localStorage flag so returning
 * visitors get the feed without preamble. The flag is versioned
 * (`_v1`) so we can re-show if the copy changes meaningfully.
 *
 * Brutalist aesthetic — yellow-50 bg matches `BecomeAPosterCallout`,
 * sharp 2px black border, monospace label strip, no shadow.
 */
export function FeedTLDR() {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      // Privacy mode / disabled storage — render the block; no harm done.
      return false
    }
  })

  if (dismissed) return null

  const onDismiss = () => {
    setDismissed(true)
    try {
      window.localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      // Same as above — failure is fine, the dismiss survives this session
      // via React state regardless.
    }
  }

  return (
    <section
      className="relative border-2 border-black bg-yellow-50 px-5 py-5 sm:px-6 mb-6"
      aria-label="What is thatsRekt?"
    >
      <button
        type="button"
        onClick={onDismiss}
        aria-label="dismiss"
        className="absolute top-1.5 right-1.5 inline-flex items-center justify-center w-7 h-7 text-neutral-600 hover:text-black hover:bg-yellow-200 active:bg-yellow-300 transition-colors leading-none"
      >
        ✕
      </button>

      <p className="text-[10px] uppercase tracking-widest text-neutral-700 mb-2">
        [new here?]
      </p>
      <p className="text-base leading-relaxed text-neutral-800 mb-2 pr-6">
        thatsRekt is an{' '}
        <strong className="font-black">on-chain hack alert registry</strong>.
        Vetted security teams post structured alerts the moment they spot
        a live exploit on any EVM chain — attacker addresses, victim
        contracts, free-form context. Other whitelisters race to vouch
        or refute.
      </p>
      <p className="text-sm leading-relaxed text-neutral-800">
        Wallets, DEXs, bridges, and lending markets read this state{' '}
        <strong className="font-black">directly on-chain</strong> to
        protect their users in real time. The live feed is below.{' '}
        <Link to="/about" className="rekt-link font-black uppercase tracking-widest text-xs">
          more →
        </Link>{' '}
        <Link to="/docs" className="rekt-link font-black uppercase tracking-widest text-xs ml-2">
          integrate →
        </Link>
      </p>
      <div className="mt-4">
        <TgChannelCTA variant="panel" />
      </div>
    </section>
  )
}
