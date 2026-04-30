import { Maintainers } from '../components/Maintainers'
import { DonateAddress } from '../components/DonateAddress'
import { BecomeAPosterCallout } from '../components/BecomeAPosterCallout'

/**
 * "About thatsRekt." Four-section narrative:
 *
 *   1. Hero          — the elevator pitch
 *   2. How it works  — posts / governance / reads (terse)
 *   3. Maintainers   — who runs it
 *   4. Donate        — how to support
 *
 * The "for protocol teams" yellow callout was deliberately removed —
 * a curious integrator can find /docs from the top nav without being
 * funneled there. Better to under-sell than over-funnel.
 */
export function About() {
  return (
    <article className="space-y-12">
      <Hero />
      <HowItWorks />
      <Maintainers />
      <DonateSection />
    </article>
  )
}

function Hero() {
  return (
    <header className="space-y-4 border-b-2 border-black pb-6">
      <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
        about
      </h1>
      <p className="text-xs uppercase tracking-widest text-red-600 font-black">
        [public good · open to read · permissioned to post]
      </p>
      <p className="text-lg sm:text-xl leading-tight text-neutral-900 font-black tracking-tight max-w-2xl">
        thatsRekt is the on-chain hack alert registry — a public list
        of active DeFi attacks, posted as they happen by vetted
        security teams.
      </p>
      <p className="text-base leading-relaxed text-neutral-800">
        Other apps read the list. A wallet can warn before sending
        money to a flagged address; an exchange can block a swap to
        someone draining a protocol; a lending market can pause when
        its own contracts are reported under attack. The list is{' '}
        <strong className="font-black">free for anyone to read</strong>.
        Only vetted teams can post.
      </p>
      <BecomeAPosterCallout variant="inline" />
      <p className="text-base leading-relaxed text-neutral-800">
        <strong className="font-black">No fees. No tokens. No profit motive.</strong>{' '}
        Built so the broader ecosystem has reliable hack-detection
        infrastructure — not so any one team can monetize knowing
        about exploits first.
      </p>
    </header>
  )
}

function HowItWorks() {
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="font-black uppercase tracking-tighter text-2xl sm:text-3xl leading-none">
          how it works
        </h2>
      </header>
      <div className="space-y-4 sm:space-y-3">
        <Bullet label="who posts">
          Vetted security teams and automated detectors. They submit
          alerts (attacker addresses, victim contracts, a short note)
          and confirm or refute each other's claims.
        </Bullet>
        <Bullet label="who runs it">
          A multisig manages the list of authorized posters{' '}
          <strong className="font-black">instantly</strong> — a bad
          actor can be kicked immediately. Contract upgrades are
          separate and gated by a{' '}
          <strong className="font-black">7-day timelock</strong>, so
          integrators always have a week to back out of a malicious
          upgrade.
        </Bullet>
        <Bullet label="who reads it">
          Anyone. Wallets, exchanges, and lending markets can ask
          before letting a transaction settle:{' '}
          <em>"is this address dangerous?"</em> The registry answers
          with a score from the confirmer activity, plus a flag for
          known victim contracts.
        </Bullet>
      </div>
    </section>
  )
}

function Bullet({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  // Stacks vertically on mobile (label above text) so long labels
  // don't clip into the right column. On sm+ goes side-by-side with
  // a fixed-width label gutter for easy scanning.
  return (
    <div className="flex flex-col sm:flex-row sm:gap-3 sm:items-baseline">
      <span className="font-black uppercase tracking-widest text-[10px] text-neutral-700 sm:shrink-0 sm:w-28 mb-1 sm:mb-0">
        [{label}]
      </span>
      <p className="text-sm leading-relaxed text-neutral-800 min-w-0">
        {children}
      </p>
    </div>
  )
}

function DonateSection() {
  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h2 className="font-black uppercase tracking-tighter text-2xl sm:text-3xl leading-none">
          donate
        </h2>
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [help cover gateway + indexer costs]
        </p>
      </header>
      <p className="text-base leading-relaxed text-neutral-800">
        If the registry has saved a user from a bad transaction, or if
        you'd like to help cover the cost of running the gateway and
        the indexers, donations are welcome on any EVM chain.
      </p>

      <div className="flex flex-col items-center space-y-3 text-center pt-2">
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [donation address]
        </p>
        <DonateAddress />
        <p className="max-w-md text-xs leading-relaxed text-neutral-700">
          Send on any EVM chain — Ethereum, Base, Arbitrum, Optimism,
          Polygon, and so on. The ENS resolves to the same controlling
          address everywhere.
        </p>
      </div>
    </section>
  )
}
