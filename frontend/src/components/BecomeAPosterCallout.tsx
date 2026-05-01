/**
 * Email address for prospective guardians to apply. Defined in one
 * place so swapping it out is a single edit.
 */
export const BECOME_POSTER_EMAIL = 'thatsrekt@protonmail.com'

interface BecomeAPosterCalloutProps {
  /**
   * Visual treatment:
   *   - `card`  — full bordered card, used on /docs
   *   - `inline`— compact prose paragraph, used on /about under the hero
   */
  variant?: 'card' | 'inline'
}

export function BecomeAPosterCallout({
  variant = 'card',
}: BecomeAPosterCalloutProps) {
  const subject = encodeURIComponent('thatsRekt — guardian application')
  const body = encodeURIComponent(
    [
      'Team / detector name:',
      'Public profile (X / GitHub / website):',
      'Detection focus (which protocols, which chains, which exploit classes):',
      'Existing track record (writeups, prior incidents flagged, etc.):',
      'Address you want whitelisted:',
      '',
      "We'll review and reply with next steps.",
    ].join('\n'),
  )
  const mailto = `mailto:${BECOME_POSTER_EMAIL}?subject=${subject}&body=${body}`

  if (variant === 'inline') {
    return (
      <p className="text-sm leading-relaxed text-neutral-800">
        Run a security team or automated detector?{' '}
        <a href={mailto} className="rekt-link font-black uppercase tracking-widest text-red-600">
          apply to guard →
        </a>
      </p>
    )
  }

  return (
    <section className="border-2 border-black bg-yellow-50 p-5 space-y-3">
      <h3 className="font-black uppercase tracking-widest text-xs">
        become a guardian
      </h3>
      <p className="text-sm leading-relaxed text-neutral-800">
        Reporting is permissioned — addresses are added to the whitelist
        by governance after a vetting review. If you run a security
        team, an exploit detector, or any pipeline that produces
        timely on-chain incident signals, get in touch.
      </p>
      <p className="text-sm leading-relaxed text-neutral-800">
        Send a short pitch — track record, detection focus, and the
        address you want whitelisted. We'll review and add you.
      </p>
      <a
        href={mailto}
        className="inline-flex items-center gap-1 mt-1 border-2 border-red-600 bg-red-600 text-white px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-red-700 hover:border-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-2"
      >
        <span>email {BECOME_POSTER_EMAIL}</span>
        <span aria-hidden="true">→</span>
      </a>
    </section>
  )
}
