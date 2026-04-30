import { useState } from 'react'

const DONATE_ENS = 'thatsrekt.eth'

/**
 * Single ENS address that accepts donations on any EVM chain. Lives as
 * a reusable component because both the Donate page (legacy, being
 * removed) and the About page surface it.
 */
export function DonateAddress() {
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
