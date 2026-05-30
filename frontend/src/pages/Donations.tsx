import { DonateAddress } from '../components/DonateAddress'
import { useSafeBalances, ETH_PRICE_USD } from '../hooks/useSafeBalances'

// ─── edit this to reflect the current yearly running cost ────────────────────
const YEARLY_GOAL_USD = 1_500
// ─────────────────────────────────────────────────────────────────────────────

export function Donations() {
  const { data, isLoading, isError } = useSafeBalances()

  const totalUsd = data?.totalUsd ?? 0
  const rawPct = YEARLY_GOAL_USD > 0 ? (totalUsd / YEARLY_GOAL_USD) * 100 : 0
  const clampedPct = Math.min(rawPct, 100)
  const pctLabel = rawPct < 1 ? rawPct.toFixed(1) : String(Math.round(rawPct))

  return (
    <article className="space-y-10">
      <header className="space-y-3 border-b-2 border-black pb-6">
        <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
          donate
        </h1>
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [help cover gateway + indexer costs]
        </p>
        <p className="text-base leading-relaxed text-neutral-800">
          If the registry has saved a user from a bad transaction, or if
          you'd like to help cover the cost of running the gateway and the
          indexers, donations are welcome on any EVM chain.
        </p>
      </header>

      {/* Donation address — centred, matches the About page layout */}
      <section className="flex flex-col items-center space-y-3 text-center">
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [donation address]
        </p>
        <DonateAddress />
        <p className="max-w-md text-xs leading-relaxed text-neutral-700">
          Send on any EVM chain — Ethereum, Base, Arbitrum, Optimism, Polygon,
          and so on. The ENS resolves to the same controlling address
          everywhere.
        </p>
      </section>

      {/* Yearly goal progress bar */}
      <section className="border-2 border-black p-4 sm:p-6 space-y-4">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="font-black uppercase tracking-tighter text-xl leading-none">
            yearly goal
          </h2>
          <span className="text-xs uppercase tracking-widest text-neutral-700">
            {isLoading && '…'}
            {isError && 'unavailable'}
            {data && `${pctLabel}% covered`}
          </span>
        </div>

        {/* Bar */}
        <div className="relative h-7 border-2 border-black bg-[#f5f4ee] overflow-hidden">
          <div
            className="h-full bg-black transition-all duration-700"
            style={{ width: isLoading ? '0%' : `${clampedPct}%` }}
          />
          {/* Inline label — only when bar is wide enough to hold it */}
          {!isLoading && clampedPct >= 15 && (
            <span className="absolute inset-0 flex items-center pl-2 text-[10px] font-black uppercase tracking-widest text-[#f5f4ee] pointer-events-none select-none">
              {pctLabel}%
            </span>
          )}
        </div>

        {/* Dollar labels */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-black text-2xl leading-none">
              {isLoading ? (
                <span className="text-neutral-400">…</span>
              ) : isError ? (
                <span className="text-neutral-400">—</span>
              ) : (
                `$${totalUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
              )}
            </p>
            <p className="text-xs uppercase tracking-widest text-neutral-700 mt-1">raised</p>
          </div>
          <div className="text-right">
            <p className="font-black text-2xl leading-none">
              ${YEARLY_GOAL_USD.toLocaleString('en-US')}
            </p>
            <p className="text-xs uppercase tracking-widest text-neutral-700 mt-1">annual target</p>
          </div>
        </div>

        {/* Token breakdown */}
        {data && data.tokens.length > 0 && (
          <div className="border-t-2 border-black pt-4 space-y-2">
            {data.tokens.map((token) => (
              <div
                key={token.tokenAddress ?? 'native'}
                className="flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  {token.logoUri && (
                    <img
                      src={token.logoUri}
                      alt=""
                      aria-hidden
                      className="w-4 h-4 rounded-full shrink-0"
                    />
                  )}
                  <span className="font-black uppercase text-xs tracking-widest">
                    {token.symbol}
                  </span>
                </div>
                <span className="font-mono text-xs text-neutral-700">
                  {token.balance < 0.0001
                    ? token.balance.toFixed(6)
                    : token.balance.toLocaleString('en-US', { maximumFractionDigits: 4 })}
                  {token.isKnown && (
                    <span className="ml-2 text-neutral-500">
                      (${token.usdValue.toLocaleString('en-US', { maximumFractionDigits: 0 })})
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        <p className="text-[10px] uppercase tracking-widest text-neutral-400 border-t border-neutral-200 pt-3">
          eth priced at ${ETH_PRICE_USD.toLocaleString()} · balances via safe api · refreshes every 5 min
        </p>
      </section>

    </article>
  )
}
