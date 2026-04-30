import { Maintainers } from '../components/Maintainers'
import { WhitelistersByChain } from '../components/WhitelistersByChain'
import { DonateAddress } from '../components/DonateAddress'

/**
 * "About thatsRekt." Single page that answers the four questions
 * a curious visitor brings to the site:
 *
 *   1. What is this?      — hero + public-good copy
 *   2. Who runs it?       — maintainers
 *   3. Who can post?      — whitelisters per chain
 *   4. How can I help?    — donate
 *
 * Replaces the old /contributors and /donate routes.
 */
export function About() {
  return (
    <article className="space-y-12">
      <Hero />
      <Maintainers />
      <ContributorsSection />
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
      <p className="text-xs uppercase tracking-widest text-neutral-700">
        [public good · no profit motive]
      </p>
      <div className="space-y-4 pt-2">
        <p className="text-base leading-relaxed text-neutral-800">
          <strong className="font-black">thatsRekt is a public good.</strong>{' '}
          Reads are open to anyone — every score, every post, every
          confirmer set is queryable from any contract or app. Nobody
          profits from running it, and nobody is meant to.
        </p>
        <p className="text-base leading-relaxed text-neutral-800">
          Posting hack alerts is permissioned: only whitelisted
          operators can post or confirm. A{' '}
          <strong className="font-black">governance multisig rules the protocol</strong>
          {' '}— it controls the whitelist and can upgrade the contract,
          but every change goes through a{' '}
          <strong className="font-black">7-day timelock</strong>.
          Integrators always have a week to disengage if a malicious
          change is queued.
        </p>
        <p className="text-base leading-relaxed text-neutral-800">
          The point is to make hack alerts a piece of{' '}
          <em>shared infrastructure</em> — something every DEX, wallet,
          stablecoin, and risk dashboard can plug into and trust. Built
          for the broader ecosystem, not for any one team.
        </p>
      </div>
    </header>
  )
}

function ContributorsSection() {
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="font-black uppercase tracking-tighter text-2xl sm:text-3xl leading-none">
          contributors
        </h2>
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [whitelisted addresses · per chain]
        </p>
      </header>
      <p className="text-base leading-relaxed text-neutral-800">
        These are the addresses authorized to{' '}
        <strong className="font-black">post hack alerts</strong> and
        confirm posts on the registry, per chain. They are added and
        removed by the governance multisig through the 7-day timelock —
        the on-chain whitelist is the source of truth, the names below
        are a courtesy lookup.
      </p>
      <WhitelistersByChain />
    </section>
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
        the indexers, donations to the address below — on any EVM chain
        — are welcome.
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
