import { useState } from 'react'
import { Link } from 'react-router-dom'
import { TG_CHANNEL_URL } from './TgChannelCTA'

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
        <strong className="font-black">onchain hack alert registry</strong>.
        Vetted security teams report structured alerts the moment they spot
        a live exploit on any EVM chain — attacker addresses, victim
        contracts, free-form context. Other guardians race to vouch
        or refute.
      </p>
      <p className="text-base leading-relaxed text-neutral-800">
        Wallets, DEXs, bridges, and lending markets read this state{' '}
        <strong className="font-black">directly onchain</strong> to
        protect their users in real time. The live feed is below.{' '}
        <Link to="/docs" className="rekt-link font-black uppercase tracking-widest text-xs">
          integrate →
        </Link>
      </p>

      <DualCTAPanel />
    </section>
  )
}

/**
 * Two-CTA stack at the bottom of the TLDR.
 *
 *   - Primary (filled red): `[apply as guardian →]` — routes to /apply.
 *     Guardians do the reporting.
 *   - Secondary (outline red): `[join alerts ↗]` — links to the
 *     public Telegram alerts channel. The rest of the world reads.
 *
 * Replaces the previous single `<TgChannelCTA variant="panel" />`
 * inline in this block. The About page still uses the panel variant —
 * see `TgChannelCTA.tsx`.
 */
function DualCTAPanel() {
  return (
    <section className="mt-4 border-2 border-black bg-white p-4 space-y-3">
      <p className="text-[10px] uppercase tracking-widest text-neutral-700">
        [two paths]
      </p>
      <p className="text-sm leading-relaxed text-neutral-800">
        Guardians report. The rest of the world reads. Pick whichever you are.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/apply"
          aria-label="apply to become a guardian"
          className="inline-flex items-center gap-1 border-2 border-red-600 bg-red-600 text-white px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-red-700 hover:border-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-1"
        >
          [apply as guardian <span aria-hidden="true">→</span>]
        </Link>
        <a
          href={TG_CHANNEL_URL}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="join the thatsRekt telegram alerts channel"
          className="inline-flex items-center gap-1 border-2 border-red-600 bg-white text-red-600 px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-red-50 transition-colors focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-1"
        >
          [join alerts <span aria-hidden="true">↗</span>]
        </a>
      </div>
    </section>
  )
}
