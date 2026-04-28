import { useState } from 'react'

const DONATE_ENS = 'thatsrekt.eth'

/**
 * The donate page. Public-good positioning + a single ENS address that
 * accepts donations on any EVM chain. The user is given the same
 * mobile-friendly copy affordances as the rest of the app.
 */
export function Donate() {
  return (
    <article className="space-y-10">
      <header className="space-y-4 border-b-2 border-black pb-6">
        <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
          donate
        </h1>
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [public good · no profit motive]
        </p>
      </header>

      <section className="space-y-4">
        <p className="text-base leading-relaxed text-neutral-800">
          <strong className="font-black">thatsRekt is a public good.</strong>{' '}
          Reads are open to anyone — every score, every post, every confirmer
          set is queryable from any contract or app. Nobody profits from
          running it, and nobody is meant to.
        </p>
        <p className="text-base leading-relaxed text-neutral-800">
          Posting hack alerts is permissioned: only whitelisted operators
          can post or confirm. A{' '}
          <strong className="font-black">governance multisig rules the protocol</strong>
          {' '}— it controls the whitelist and can upgrade the contract, but
          every change goes through a{' '}
          <strong className="font-black">7-day timelock</strong>. Integrators
          always have a week to disengage if a malicious change is queued.
        </p>
        <p className="text-base leading-relaxed text-neutral-800">
          The point is to make hack alerts a piece of <em>shared infrastructure</em> —
          something every DEX, wallet, stablecoin, and risk dashboard can plug
          into and trust. Built for the broader ecosystem, not for any one
          team.
        </p>
        <p className="text-base leading-relaxed text-neutral-800">
          If the registry has saved a user from a bad transaction, or if
          you'd like to help cover the cost of running the gateway and the
          indexers, donations to the address below — on any EVM chain —
          are welcome.
        </p>
      </section>

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
    </article>
  )
}

function DonateAddress() {
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(DONATE_ENS)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // older browsers / non-secure contexts: tap-and-hold to select
    }
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={onCopy}
        title={copied ? 'copied!' : `copy ${DONATE_ENS}`}
        aria-label={`Copy ${DONATE_ENS}`}
        className="group inline-flex items-center justify-center gap-4 border-2 border-black bg-white px-6 py-4 hover:bg-yellow-100 active:bg-yellow-200 transition-colors min-h-[3.25rem] touch-manipulation"
      >
        <span className="font-mono text-xl sm:text-2xl font-black tracking-tight">
          {DONATE_ENS}
        </span>
        <span className="inline-flex items-center justify-center w-8 h-8 text-neutral-500 group-hover:text-black transition-colors">
          {copied ? <CheckIcon /> : <CopyIcon />}
        </span>
      </button>
      {copied && (
        <span className="font-mono text-sm font-black uppercase tracking-widest text-emerald-700">
          ✓ copied
        </span>
      )}
      <a
        href={`https://app.ens.domains/${DONATE_ENS}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs uppercase tracking-widest rekt-link"
      >
        view on ens ↗
      </a>
    </div>
  )
}

function CopyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-5 h-5"
      aria-hidden="true"
    >
      <path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12A1.5 1.5 0 0117 6.622V12.5a1.5 1.5 0 01-1.5 1.5h-1v-3.379a3 3 0 00-.879-2.121L10.5 5.379A3 3 0 008.379 4.5H7v-1z" />
      <path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-5.879a1.5 1.5 0 00-.44-1.06L9.44 6.439A1.5 1.5 0 008.378 6H4.5z" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-5 h-5 text-emerald-600"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
        clipRule="evenodd"
      />
    </svg>
  )
}
