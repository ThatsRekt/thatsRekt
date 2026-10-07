import { DonateAddress } from './DonateAddress'
import { DAO_FUND_INITIATIVE_URL } from '../lib/daoFund'

/**
 * Primary ask is the DAO Fund campaign. The ENS address stays as the
 * legacy direct-send path.
 */
export function DonationOptions() {
  return (
    <>
      <section className="border-2 border-red-600 bg-red-50 p-4 sm:p-6 space-y-3">
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [the dao fund]
        </p>
        <h2 className="font-black uppercase tracking-tighter text-2xl leading-none">
          donate on the campaign
        </h2>
        <p className="text-base leading-relaxed text-neutral-800">
          Selected for The DAO Fund, an Ethereum security public good.
          Donate there.
        </p>
        <a
          href={DAO_FUND_INITIATIVE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 border-2 border-red-600 bg-red-600 text-white px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-black hover:border-black transition-colors"
        >
          Please support →
        </a>
      </section>

      <section className="flex flex-col items-center space-y-3 text-center">
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [legacy donation address]
        </p>
        <DonateAddress />
        <p className="max-w-md text-xs leading-relaxed text-neutral-700">
          Direct sends to thatsrekt.eth still work, on any EVM chain.
          Ethereum, Base, Arbitrum, Optimism, Polygon, and so on. The ENS
          resolves to the same controlling address everywhere.
        </p>
      </section>
    </>
  )
}
