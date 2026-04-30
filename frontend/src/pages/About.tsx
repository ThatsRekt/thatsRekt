import { Maintainers } from '../components/Maintainers'
import { DonateAddress } from '../components/DonateAddress'

/**
 * "About thatsRekt." Five-section narrative leading with the
 * elevator pitch:
 *
 *   1. Hero            — what this is + why it matters
 *   2. How it works    — posts / governance / reads
 *   3. For integrators — the call-to-action for protocol teams
 *   4. Maintainers     — who runs it
 *   5. Donate          — how to support
 *
 * The directory of authorized posters used to live here; it now has
 * its own /posters route. This page focuses on the public-good
 * positioning rather than the operational details.
 */
export function About() {
  return (
    <article className="space-y-12">
      <Hero />
      <HowItWorks />
      <ForIntegrators />
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
      <p className="text-xl leading-tight text-neutral-900 font-black tracking-tight max-w-2xl">
        thatsRekt is the on-chain hack alert registry — a shared
        siren that DEXes, wallets, and stablecoins can plug into to
        protect users from active exploits in real time.
      </p>
      <p className="text-base leading-relaxed text-neutral-800">
        Every score, every post, every confirmer set is queryable
        from any contract or app.{' '}
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
      <div className="space-y-3">
        <Bullet label="who posts">
          A whitelist of vetted security teams + automated detectors,
          managed by a governance multisig. They submit structured
          alerts (attacker addresses, victim contracts, free-form
          context) and confirm or refute each other's posts. The
          on-chain whitelist is the source of truth — see{' '}
          <em>posters</em> for the live roster per chain.
        </Bullet>
        <Bullet label="how governance works">
          A multisig controls the whitelist and can upgrade the
          contract — but every change goes through a{' '}
          <strong className="font-black">7-day TimelockController</strong>.
          Integrators always have a week to disengage if a malicious
          change is queued.
        </Bullet>
        <Bullet label="how reads work">
          Anyone — any contract, any indexer, any app — can read the
          registry. Two main signals: an address's{' '}
          <em>attackerScore</em> (signed integer summed across
          confirmer activity) and an address's <em>isVictim</em> flag.
          See <em>docs</em> for code examples.
        </Bullet>
      </div>
    </section>
  )
}

function ForIntegrators() {
  return (
    <section className="space-y-3 border-2 border-black bg-yellow-50 p-5">
      <h2 className="font-black uppercase tracking-widest text-xs">
        for protocol teams
      </h2>
      <p className="text-sm leading-relaxed text-neutral-800">
        If your DEX, wallet, lending market, or stablecoin can read
        an on-chain score before letting a transaction settle, you
        can save users from loss with a single view call. The
        registry is permissionless to read. Drop in the interface,
        pick a threshold, and ship.
      </p>
      <p className="text-sm leading-relaxed text-neutral-800">
        See <strong className="font-black">docs</strong> for the
        Solidity interface, GraphQL examples, and per-chain
        deployment addresses.
      </p>
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
  return (
    <div className="flex gap-3 items-baseline">
      <span className="font-black uppercase tracking-widest text-[10px] text-neutral-700 whitespace-nowrap shrink-0 w-32 sm:w-40">
        [{label}]
      </span>
      <p className="text-sm leading-relaxed text-neutral-800">
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
        If the registry has saved a user from a bad transaction, or
        if you'd like to help cover the cost of running the gateway
        and the indexers, donations to the address below — on any
        EVM chain — are welcome.
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
