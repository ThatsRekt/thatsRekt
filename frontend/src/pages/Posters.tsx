import { WhitelistersByChain } from '../components/WhitelistersByChain'

/**
 * Posters page — the directory of every whitelisted address that
 * can submit hack alerts on the registry, broken down per chain.
 *
 * Posters and the leaderboard are two views of the same on-chain
 * concept (whitelisted addresses): this page is the static directory
 * sourced from the indexer's whitelist event log; `/leaderboard`
 * ranks them by lifetime confirmation activity.
 */
export function Posters() {
  return (
    <article className="space-y-10">
      <header className="space-y-3 border-b-2 border-black pb-6">
        <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
          posters
        </h1>
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [whitelisted addresses · per chain]
        </p>
        <p className="text-base leading-relaxed text-neutral-800">
          These are the addresses authorized to{' '}
          <strong className="font-black">post hack alerts</strong> and
          confirm posts on the registry, per chain. They are added and
          removed by the governance multisig through the 7-day timelock —
          the on-chain whitelist is the source of truth, the names below
          are a courtesy lookup.
        </p>
      </header>

      <WhitelistersByChain />
    </article>
  )
}
