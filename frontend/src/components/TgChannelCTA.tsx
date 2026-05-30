/**
 * Telegram channel CTA — the public alerts feed lives at
 * `@thatsrekt_alerts`. New visitors don't know about it; this module
 * surfaces it in two layout slots:
 *
 *   - `GetAlertsButton`  — red brutalist CTA next to the [post] button
 *                          in the header. Two variants (desktop / mobile)
 *                          mirror `PostAlertButton`'s layout split.
 *   - `TgChannelCTA panel` — bigger bracketed card for FeedTLDR + About.
 *                          Sits inline in those pages' explainer blocks.
 *
 * No new deps; arrows are unicode glyphs to stay consistent with the
 * rest of the brutalist UI.
 */
export const TG_CHANNEL_URL = 'https://t.me/thatsrekt_alerts'
export const TG_CHANNEL_HANDLE = '@thatsrekt_alerts'

/**
 * Header-mounted "get alerts" CTA. Secondary action — paired with the
 * primary `[post]` button next to it. Visual hierarchy via outline-red
 * vs Post's fill-red:
 *
 *   - same color family, so both reads as "active" CTAs in the brand red
 *   - outline weight is lighter, so Post still claims the primary slot
 *   - the trailing `↗` glyph signals "leaves the site"
 *
 * Pure link — no wallet check, no modal, no state. `whitespace-nowrap`
 * keeps the two-word label on one line even when the parent flex row
 * is squeezed (nav links + post button + account chip).
 */
export function GetAlertsButton({
  variant = 'desktop',
  onAfterClick,
}: {
  variant?: 'desktop' | 'mobile'
  /** Mirrors `PostAlertButton`'s mobile-menu close hook. */
  onAfterClick?: () => void
}) {
  return (
    <a
      href={TG_CHANNEL_URL}
      target="_blank"
      rel="noreferrer noopener"
      onClick={onAfterClick}
      aria-label="get real-time alerts on the thatsRekt telegram channel"
      className={
        variant === 'desktop'
          ? 'inline-flex items-center gap-1 whitespace-nowrap border-2 border-red-600 bg-white text-red-600 px-3 py-1 text-[11px] uppercase tracking-widest font-black hover:bg-red-50 transition-colors focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-1'
          : 'block w-full text-left px-4 py-3 text-sm uppercase tracking-widest font-black border-y-2 border-red-600 bg-white text-red-600 hover:bg-red-50 active:bg-red-100 transition-colors'
      }
    >
      get alerts <span aria-hidden="true">↗</span>
    </a>
  )
}

/**
 * Bracketed panel CTA for the FeedTLDR explainer + the About page's
 * "[get alerts]" section. Larger surface area than the header button
 * and includes a one-liner pitch for the channel.
 */
export function TgChannelCTA({ variant }: { variant: 'panel' }) {
  if (variant === 'panel') return <PanelVariant />
  return null
}

function PanelVariant() {
  return (
    <section
      className="border-2 border-black bg-white p-4 space-y-3"
      aria-label="follow live alerts on telegram"
    >
      <p className="text-sm leading-relaxed text-neutral-800">
        Alerts in real time on{' '}
        <span className="font-mono font-black">{TG_CHANNEL_HANDLE}</span>.
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
