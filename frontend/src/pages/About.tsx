import { Maintainers } from '../components/Maintainers'
import { BecomeAPosterCallout } from '../components/BecomeAPosterCallout'
import { TgChannelCTA } from '../components/TgChannelCTA'

/**
 * "About thatsRekt." Five-section narrative:
 *
 *   1. Hero          — the elevator pitch
 *   2. How it works  — posts / governance / reads (terse)
 *   3. Ways to use   — concrete scenarios for visitors
 *   4. Get alerts    — Telegram channel CTA (high-intent placement
 *                       directly after "ways to use" is read)
 *   5. Maintainers   — who runs it
 */
export function About() {
  return (
    <article className="space-y-12">
      <Hero />
      <HowItWorks />
      <WaysToUse />
      <GetAlertsSection />
      <Maintainers />
    </article>
  )
}

/**
 * "Ways to use it" — the missing piece of the page. Newcomers see the
 * elevator pitch + how-it-works but bounce because they can't picture
 * what they (or their team) would actually do with it. Three concrete,
 * plain-language scenarios across the audience spectrum.
 *
 * For deeper integration shapes / Solidity examples, /docs has a
 * "use cases" section with code snippets — this is the introductory
 * slice for general readers.
 */
function WaysToUse() {
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="font-black uppercase tracking-tighter text-2xl sm:text-3xl leading-none">
          ways to use it
        </h2>
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [for builders · for security teams · for everyone]
        </p>
      </header>
      <div className="space-y-4 sm:space-y-3">
        <Bullet label="if you build a wallet">
          Pre-flight every outbound transfer. Check the recipient's
          attacker score before signing — if it's been confirmed by
          peers as a hack address, warn the user before money leaves.
        </Bullet>
        <Bullet label="if you build a DEX or bridge">
          Read directly from the registry on-chain. Block swaps where
          the input or output token has been reported as a victim
          contract; refuse cross-chain releases to flagged addresses.
        </Bullet>
        <Bullet label="if you run a lending market">
          A keeper checks whether your own contracts appear in any
          active alert. The second a peer security team posts about
          your protocol being drained, your pause guardian can fire —
          even if your team hasn't woken up yet.
        </Bullet>
        <Bullet label="if you run a security team or detector">
          Apply for guardian status. The moment your fork-monitor or
          mempool scanner fires, report the attacker addresses on-chain.
          Other guardians race to confirm or refute. Confirmer
          karma builds reputation over time.
        </Bullet>
        <Bullet label="if you're just curious">
          Browse the feed. Every attack links to the actual on-chain
          attack tx, the attacker addresses, and the victim contracts
          — before-the-fact incident reporting, not after-the-fact news.
        </Bullet>
      </div>
    </section>
  )
}

function Hero() {
  return (
    <header className="space-y-4 border-b-2 border-black pb-6">
      <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
        about
      </h1>
      <p className="text-xs uppercase tracking-widest text-red-600 font-black">
        [public good · open to read · permissioned to report]
      </p>
      <p className="text-lg sm:text-xl leading-tight text-neutral-900 font-black tracking-tight max-w-2xl">
        thatsRekt is the on-chain hack alert registry — a public list
        of active on-chain exploits across every EVM chain, reported
        as they happen by vetted security firms and industry peers.
      </p>
      <p className="text-base leading-relaxed text-neutral-800">
        Two kinds of guardians keep the registry honest. Security
        firms are fast — they spot exploits in flight and post the
        alert first. High-signal industry peers are the second line:
        they confirm or refute the report on-chain so consumers
        downstream can trust what they read.
      </p>
      <p className="text-base leading-relaxed text-neutral-800">
        Other apps read the list. A wallet can warn before sending
        money to a flagged address; an exchange can block a swap to
        someone draining a protocol; a lending market can pause when
        its own contracts are reported under attack. The list is{' '}
        <strong className="font-black">free for anyone to read</strong>.
        Only vetted guardians can report.
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
        <Bullet label="who reports">
          Vetted security teams and automated detectors — the
          guardians. They submit alerts (attacker addresses, victim
          contracts, a short note) and confirm or refute each other's
          claims.
        </Bullet>
        <Bullet label="who runs it">
          A multisig manages the guardian list. Bad actors can be
          removed{' '}
          <strong className="font-black">instantly</strong>, so
          incident response stays fast. Adding a new guardian goes
          through a{' '}
          <strong className="font-black">3-day timelock</strong>, so
          operator rotation is visible before it lands. Contract
          upgrades sit on a separate{' '}
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

/**
 * "Get alerts" section — a low-friction CTA for visitors who don't run
 * detectors but want to follow live attacks. Lives between the
 * maintainers block and the donate block: by the time a reader's
 * scrolled this far they've earned an obvious next-step.
 */
function GetAlertsSection() {
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="font-black uppercase tracking-tighter text-2xl sm:text-3xl leading-none">
          get alerts
        </h2>
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [follow live attacks on telegram]
        </p>
      </header>
      <TgChannelCTA variant="panel" />
    </section>
  )
}

