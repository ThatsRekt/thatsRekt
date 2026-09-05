import { useEffect, useRef, useState } from 'react'
import { useFalseDiscoveryRate } from '../hooks/useFalseDiscoveryRate'

/**
 * Header-mounted false-discovery-rate (FDR) badge. Sits right after the
 * [report] button. Styled as a static (non-link) sibling of
 * `GetAlertsButton`'s desktop variant — same outline-red-on-white
 * brutalist box.
 *
 * Named FDR, not "false positive rate" — FPR needs a denominator of every
 * case where nothing happened, which this registry can't see. FDR (false
 * calls / all calls made) is what's actually computable from post data,
 * and matches this metric exactly. See `useFalseDiscoveryRate` for the
 * full reasoning.
 *
 * Hidden while loading and when there's no data yet (zero posts, or the
 * stats query hasn't resolved) — a "0%" badge before any posts exist would
 * read as a claim rather than an absence of data.
 *
 * The explainer is a hover/click popover rather than a native `title=`
 * tooltip — same reasoning as `InfoPopover`: native tooltips have a slow,
 * inconsistent browser delay. This inlines that same open-on-hover /
 * pin-on-click behavior directly on the badge itself (rather than adding a
 * separate "i" trigger next to it, which would clutter a compact header
 * badge).
 */
export function FalseDiscoveryRateBadge() {
  const { ratePercent, revokedCount, totalCount, isLoading } = useFalseDiscoveryRate()
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const closeTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocPointerDown = (e: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
        setPinned(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setPinned(false)
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    }
  }, [])

  if (isLoading || ratePercent === null || totalCount === 0) return null

  const display = ratePercent < 10 ? ratePercent.toFixed(1) : Math.round(ratePercent).toString()

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const scheduleClose = () => {
    if (pinned) return
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 120)
  }

  return (
    <span
      ref={wrapperRef}
      className="relative inline-flex items-center"
      onMouseEnter={() => {
        cancelClose()
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        onClick={() => {
          if (pinned) {
            setOpen(false)
            setPinned(false)
          } else {
            setOpen(true)
            setPinned(true)
          }
        }}
        aria-expanded={open}
        aria-label={`false discovery rate: ${display} percent, ${revokedCount} of ${totalCount} posts revoked`}
        className="inline-flex items-center gap-1 whitespace-nowrap border-2 border-red-600 bg-white text-red-600 px-3 py-1 text-[11px] uppercase tracking-widest font-black cursor-pointer"
      >
        {display}%
      </button>

      {open && (
        <div
          role="tooltip"
          className="absolute right-0 top-full z-30 mt-2 w-64 border-2 border-black bg-[#f5f4ee] shadow-[4px_4px_0_0_#000]"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="border-b-2 border-black bg-black px-3 py-1 text-[10px] font-black uppercase tracking-widest text-[#f5f4ee]">
            FDR: false discovery rate
          </div>
          <div className="px-3 py-2 text-xs leading-relaxed text-neutral-800">
            {revokedCount} of {totalCount} posts revoked (&gt;2 downvotes).
          </div>
        </div>
      )}
    </span>
  )
}
