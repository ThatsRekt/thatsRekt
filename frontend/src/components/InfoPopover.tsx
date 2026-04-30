import { useEffect, useRef, useState } from 'react'

interface InfoPopoverProps {
  /** Short label for the title strip (uppercase, tracking-widest). */
  title: string
  /** Body content — kept readable in normal case. */
  children: React.ReactNode
  /**
   * Aria label for the trigger button. Defaults to `more info`. Set to
   * something specific when there are multiple popovers on the same page
   * so screen readers can disambiguate.
   */
  ariaLabel?: string
}

/**
 * Small click-toggleable + hover-opening popover for inline help text.
 *
 * Designed to replace the native `title=` tooltip — that one has a 1-2s
 * browser delay, no styling control, and doesn't open on click. This
 * component:
 *
 *   - opens instantly on hover
 *   - opens / pins on click (so mobile and keyboard users have a way
 *     in, and the popover stays visible while reading long copy)
 *   - closes on Escape, on click-outside, or on mouse leave (with a
 *     small grace period so you can move into the popover body)
 *
 * Styling matches the rekt aesthetic — sharp borders, hard offset
 * shadow, monospace uppercase title strip, normal-case body for
 * readability.
 */
export function InfoPopover({ title, children, ariaLabel = 'more info' }: InfoPopoverProps) {
  const [open, setOpen] = useState(false)
  /**
   * `pinned` is true when the user opened the popover by clicking, vs
   * just hovering. A pinned popover ignores mouse-leave; only an
   * explicit close (click trigger again, click outside, Escape) shuts
   * it. Hover-open popovers close as soon as the cursor leaves.
   */
  const [pinned, setPinned] = useState(false)
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const closeTimer = useRef<number | null>(null)

  // Click outside or Escape: always closes (pinned or not).
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

  // Cleanup any pending close timer on unmount.
  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current)
      }
    }
  }, [])

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const scheduleClose = () => {
    if (pinned) return
    cancelClose()
    closeTimer.current = window.setTimeout(() => {
      setOpen(false)
    }, 120)
  }

  const onTriggerClick = () => {
    if (pinned) {
      // toggle off when already pinned
      setOpen(false)
      setPinned(false)
    } else {
      setOpen(true)
      setPinned(true)
    }
  }

  return (
    <span
      ref={wrapperRef}
      className="relative inline-flex items-baseline"
      onMouseEnter={() => {
        cancelClose()
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        onClick={onTriggerClick}
        aria-label={ariaLabel}
        aria-expanded={open}
        className={
          'inline-flex items-center justify-center w-4 h-4 rounded-full border text-[10px] font-mono cursor-pointer transition-colors ' +
          (open
            ? 'border-black bg-black text-[#f5f4ee]'
            : 'border-neutral-500 text-neutral-700 hover:border-black hover:text-black')
        }
      >
        i
      </button>

      {open && (
        <div
          role="tooltip"
          className="absolute left-1/2 top-full z-30 mt-2 w-72 -translate-x-1/2 border-2 border-black bg-[#f5f4ee] shadow-[4px_4px_0_0_#000]"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="border-b-2 border-black bg-black px-3 py-1 text-[10px] font-black uppercase tracking-widest text-[#f5f4ee]">
            {title}
          </div>
          <div className="px-3 py-2 text-xs leading-relaxed text-neutral-800">
            {children}
          </div>
        </div>
      )}
    </span>
  )
}
