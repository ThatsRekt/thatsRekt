import { useState } from 'react'
import { shortAddress } from '../lib/format'
import { explorerAddressUrl, getChainBySlug } from '../lib/chains'

interface AddressLabelProps {
  addr: string
  /** When set, the explorer icon links to this chain's block explorer. */
  chainSlug?: string
  full?: boolean
}

/**
 * Address with mobile-friendly affordances:
 *   - Copy icon button — always visible, tap target ≥ 28px.
 *   - Explorer icon link — always visible (when chainSlug provided).
 *   - Address text itself is tappable too (also copies) for convenience.
 *
 * Icons are inline SVG so the component has no asset dependency.
 */
export function AddressLabel({ addr, chainSlug, full = false }: AddressLabelProps) {
  const [copied, setCopied] = useState(false)
  const chain = chainSlug ? getChainBySlug(chainSlug) : undefined
  const explorerUrl = chain ? explorerAddressUrl(chain, addr) : null

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(addr)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // older browsers / non-secure contexts: no-op (user can long-press to select)
    }
  }

  return (
    // flex-wrap so the address text can wrap to a second line on narrow
    // viewports while the icons stay grouped at the end. Without this,
    // a 42-char full address would force horizontal scroll on phones.
    <span className="inline-flex flex-wrap items-center gap-1.5 align-middle max-w-full">
      <button
        type="button"
        onClick={onCopy}
        title={copied ? 'copied!' : `copy ${addr}`}
        aria-label="Copy address"
        className={
          'font-mono text-sm hover:bg-yellow-100 active:bg-yellow-200 px-1 -mx-0.5 rounded transition-colors cursor-pointer touch-manipulation min-w-0 ' +
          // break-all only when showing the full address — short
          // (truncated) addresses are short enough not to need wrapping
          // and look better unbroken.
          (full ? 'break-all text-left' : 'whitespace-nowrap')
        }
      >
        {full ? addr : shortAddress(addr)}
      </button>
      {/* Icons sit in a single nested flex row so they ALWAYS wrap as
          a unit. Without this nesting, the outer flex-wrap could put
          the copy icon on one line and the explorer icon on another. */}
      <span className="inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap">
        <button
          type="button"
          onClick={onCopy}
          title={copied ? 'copied!' : 'copy address'}
          aria-label="Copy address"
          className="inline-flex items-center justify-center w-7 h-7 -my-1 text-neutral-500 hover:text-black active:text-red-600 active:bg-yellow-200 rounded transition-colors touch-manipulation"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={`open on ${chain?.name ?? 'block explorer'}`}
            aria-label="Open in block explorer"
            className="inline-flex items-center justify-center w-7 h-7 -my-1 text-neutral-500 hover:text-red-600 active:text-red-700 rounded transition-colors touch-manipulation"
          >
            <ExternalLinkIcon />
          </a>
        )}
      </span>
    </span>
  )
}

// --- icons (heroicons mini, inlined) ----------------------------------------

function CopyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-4 h-4"
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
      className="w-4 h-4 text-emerald-600"
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

function ExternalLinkIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-4 h-4"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z"
        clipRule="evenodd"
      />
      <path
        fillRule="evenodd"
        d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z"
        clipRule="evenodd"
      />
    </svg>
  )
}
