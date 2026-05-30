import { Link } from 'react-router-dom'

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
  if (variant === 'inline') {
    return (
      <p className="text-sm leading-relaxed text-neutral-800">
        Run a security team or automated detector?{' '}
        <Link to="/apply" className="rekt-link font-black uppercase tracking-widest text-red-600">
          apply to guard →
        </Link>
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
        timely onchain incident signals, get in touch.
      </p>
      <p className="text-sm leading-relaxed text-neutral-800">
        Submit a short application: track record, detection focus, and the
        address you want whitelisted. The governance multisig reviews each
        application and approves via an onchain timelock.
      </p>
      <Link
        to="/apply"
        className="inline-flex items-center gap-1 mt-1 border-2 border-red-600 bg-red-600 text-white px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-red-700 hover:border-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-2"
      >
        <span>apply to guard</span>
        <span aria-hidden="true">→</span>
      </Link>
    </section>
  )
}
