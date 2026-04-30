import { useState } from 'react'

interface CopyableTextProps {
  /** The text shown in the box and copied on click. */
  value: string
  /** Optional small label rendered above the value (e.g. "[endpoint]"). */
  label?: string
  /** Override the title/aria-label on the copy icon. */
  copyAriaLabel?: string
}

/**
 * Generic one-click-to-copy text block. Used for non-address values
 * like GraphQL endpoints, email addresses, etc. — for actual EVM
 * addresses, use AddressLabel which adds an explorer link too.
 *
 * Sharp brutalist box: border-2 border-black, cream background,
 * monospace value with a copy icon to the right.
 */
export function CopyableText({
  value,
  label,
  copyAriaLabel,
}: CopyableTextProps) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // fallback: user can long-press / select text manually
    }
  }

  return (
    <div className="border-2 border-black bg-neutral-50 px-3 sm:px-4 py-3 space-y-1">
      {label && (
        <p className="text-[10px] uppercase tracking-widest text-neutral-700">
          {label}
        </p>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onCopy}
          title={copied ? 'copied!' : `copy ${value}`}
          aria-label={copyAriaLabel ?? `Copy ${value}`}
          className="flex-1 min-w-0 text-left font-mono text-xs sm:text-sm break-all hover:bg-yellow-100 active:bg-yellow-200 -mx-1 px-1 rounded transition-colors cursor-pointer touch-manipulation"
        >
          {value}
        </button>
        <button
          type="button"
          onClick={onCopy}
          title={copied ? 'copied!' : 'copy to clipboard'}
          aria-label={copyAriaLabel ?? 'Copy to clipboard'}
          className="shrink-0 inline-flex items-center justify-center w-8 h-8 text-neutral-500 hover:text-black active:text-red-600 active:bg-yellow-200 rounded transition-colors touch-manipulation"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
    </div>
  )
}

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
