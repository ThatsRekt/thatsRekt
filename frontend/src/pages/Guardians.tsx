import { WhitelistersByChain } from '../components/WhitelistersByChain'
import { BecomeAPosterCallout } from '../components/BecomeAPosterCallout'

/**
 * Guardians page — the directory of every whitelisted address that
 * can submit hack alerts on the registry, broken down per chain.
 *
 * Guardians and the leaderboard are two views of the same on-chain
 * concept (whitelisted addresses): this page is the static directory
 * sourced from the indexer's whitelist event log; `/leaderboard`
 * ranks them by lifetime confirmation activity.
 *
 * Note: the on-chain primitive is still called a "poster" in contracts
 * and indexer schemas — the user-facing rebrand is purely cosmetic.
 */
export function Guardians() {
  return (
    <article className="space-y-10">
      <header className="space-y-3 border-b-2 border-black pb-6">
        <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
          guardians
        </h1>
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [whitelisted addresses · per chain]
        </p>
        <p className="text-base leading-relaxed text-neutral-800">
          These are the addresses authorized to{' '}
          <strong className="font-black">report hack attacks</strong> and
          confirm reports on the registry, per chain. New guardians are
          added through a{' '}
          <strong className="font-black">3-day timelock</strong> so
          rotation is publicly visible; misbehaving guardians are
          removed{' '}
          <strong className="font-black">instantly</strong> by the
          governance multisig. The on-chain whitelist is the source of
          truth; the names below are a courtesy lookup.
        </p>
      </header>

      <BecomeAPosterCallout />

      <WhitelistersByChain />
    </article>
  )
}
