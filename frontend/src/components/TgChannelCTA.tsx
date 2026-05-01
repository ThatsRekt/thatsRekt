/**
 * Telegram channel CTA — the public alerts feed lives at
 * `@thatsrekt_alerts`. New visitors don't know about it; this component
 * surfaces it in two visual flavors so the same copy/link work in
 * different layout slots.
 *
 *   - `pill`   — small inline button for the top nav. Same vocabulary
 *                as the brutalist nav links (border, mono, uppercase).
 *   - `panel`  — bigger bracketed card for FeedTLDR + the About page.
 *                Matches the existing TLDR-style explainer cards.
 *
 * No new deps; arrows are unicode glyphs to stay consistent with the
 * rest of the brutalist UI.
 */
export const TG_CHANNEL_URL = 'https://t.me/thatsrekt_alerts'
export const TG_CHANNEL_HANDLE = '@thatsrekt_alerts'

type Variant = 'pill' | 'panel'

export function TgChannelCTA({ variant }: { variant: Variant }) {
  if (variant === 'pill') return <PillVariant />
  return <PanelVariant />
}

function PillVariant() {
  return (
    <a
      href={TG_CHANNEL_URL}
      target="_blank"
      rel="noreferrer noopener"
      aria-label="join the thatsRekt telegram alerts channel"
      className="border-2 border-black bg-white hover:bg-yellow-100 inline-flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-widest font-mono"
    >
      [telegram <span aria-hidden="true">↗</span>]
    </a>
  )
}

function PanelVariant() {
  return (
    <section
      className="border-2 border-black bg-white p-4 space-y-3"
      aria-label="follow live alerts on telegram"
    >
      <p className="text-[10px] uppercase tracking-widest text-neutral-700">
        [follow live alerts]
      </p>
      <p className="text-sm leading-relaxed text-neutral-800">
        New posts hit{' '}
        <span className="font-mono font-black">{TG_CHANNEL_HANDLE}</span>{' '}
        in real time. Plus cosmetic ✓/✗ votes.
      </p>
      <a
        href={TG_CHANNEL_URL}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="join the thatsRekt telegram alerts channel"
        className="inline-flex items-center gap-1 border-2 border-red-600 bg-red-600 text-white px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-red-700 hover:border-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-1"
      >
        [join channel <span aria-hidden="true">↗</span>]
      </a>
    </section>
  )
}
