import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { visibleChains } from '../lib/chains'
import type { ChainFilter } from '../hooks/useChainFilter'

interface ChainSelectorProps {
  value: ChainFilter
  onChange: (next: ChainFilter) => void
}

interface Option {
  /** localStorage / hook value. `null` = "all chains". */
  readonly value: ChainFilter
  /** Visible label in the trigger and the listbox. */
  readonly label: string
}

/**
 * Custom popover-style chain dropdown.
 *
 * Replaces the native `<select>` so the control matches the rest of the
 * brutalist UI (sharp 2px borders, hard offset shadow, monospace
 * uppercase tracking-widest, no system gradients / rounded corners).
 *
 * Visual language is borrowed from:
 *
 *   - the sort buttons + archive toggle in `Feed.tsx` (trigger)
 *   - `InfoPopover` and the mobile nav menu in `App.tsx` (panel —
 *     2px black border + cream bg + 4px hard offset shadow)
 *
 * Behavior:
 *
 *   - click trigger → toggle open
 *   - Enter / Space on focused trigger → open + focus active option
 *   - ArrowUp / ArrowDown on trigger → open + move highlight
 *   - ArrowUp / ArrowDown in panel → move highlight
 *   - Home / End → jump to first / last
 *   - Enter on highlighted option → select + close + restore focus
 *   - Escape → close + restore focus
 *   - click outside (pointerdown) → close
 *   - Tab while open → close (let focus move on naturally)
 *
 * The hook contract (`value: ChainFilter`, `onChange`) is unchanged.
 */
export function ChainSelector({ value, onChange }: ChainSelectorProps) {
  const options: readonly Option[] = useMemo(() => {
    const chains = visibleChains().map<Option>((c) => ({
      value: c.slug,
      label: c.isLocalFork ? `${c.badge} · local` : c.badge,
    }))
    return [{ value: null, label: 'all chains' }, ...chains]
  }, [])

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  )
  const selected = options[selectedIndex]

  const [open, setOpen] = useState(false)
  /** Highlighted (keyboard-focused) row inside the open panel. */
  const [highlight, setHighlight] = useState(selectedIndex)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLUListElement>(null)
  const listboxId = useId()

  // Sync highlight to the current selection any time the popover opens.
  // Without this, if the user picks a chain, reopens, the highlight
  // would still point at whatever they last navigated to.
  useEffect(() => {
    if (open) setHighlight(selectedIndex)
  }, [open, selectedIndex])

  // Click outside / Escape / Tab close. Only bound when open so we don't
  // pay for a global listener on every render of the page.
  useEffect(() => {
    if (!open) return

    const onPointerDown = (e: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        // Return focus to the trigger so keyboard users don't get
        // dumped at <body>.
        triggerRef.current?.focus()
      }
      if (e.key === 'Tab') {
        // Don't trap focus — let Tab leave the control. Just close.
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Move keyboard focus into the listbox once it's mounted, so screen
  // readers announce the active option and ArrowUp/Down work inside the
  // panel without a second Tab.
  useEffect(() => {
    if (open) listboxRef.current?.focus()
  }, [open])

  const commit = (idx: number) => {
    const next = options[idx]
    if (!next) return
    onChange(next.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Open with the current selection highlighted; the panel's own
      // handler takes over from there.
      e.preventDefault()
      setOpen(true)
    } else if (e.key === 'Enter' || e.key === ' ') {
      // Browsers fire click on Space-up for buttons, which would re-toggle.
      // Pre-empt that with our own open and prevent the synthetic click.
      e.preventDefault()
      setOpen((v) => !v)
    }
  }

  const onListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => (h + 1) % options.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => (h - 1 + options.length) % options.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setHighlight(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setHighlight(options.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commit(highlight)
    }
  }

  return (
    <div
      ref={wrapperRef}
      className="relative inline-flex items-baseline gap-2 text-[10px] uppercase tracking-widest text-neutral-700"
    >
      <span>chain:</span>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        className={
          'inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono uppercase tracking-widest border ' +
          (open
            ? 'border-black bg-black text-[#f5f4ee]'
            : 'border-black text-neutral-700 hover:bg-black hover:text-[#f5f4ee]')
        }
      >
        <span>{selected?.label ?? 'all chains'}</span>
        <Caret open={open} />
      </button>

      {open && (
        <ul
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={`${listboxId}-opt-${highlight}`}
          onKeyDown={onListKeyDown}
          // right-0 + min/max width keeps the panel anchored to the right
          // edge of the trigger area. ChainSelector sits flush-right in
          // the FilterBar on desktop; on narrow viewports the max-w cap
          // prevents overflow past the page gutter.
          className="absolute right-0 top-full z-30 mt-1 min-w-[12rem] max-w-[calc(100vw-2rem)] border-2 border-black bg-[#f5f4ee] shadow-[4px_4px_0_0_#000] focus:outline-none"
        >
          {options.map((opt, i) => {
            const isSelected = i === selectedIndex
            const isHighlighted = i === highlight
            return (
              <li
                key={opt.value ?? '__all'}
                id={`${listboxId}-opt-${i}`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => commit(i)}
                className={
                  'flex items-center gap-2 px-3 py-1.5 text-xs font-mono uppercase tracking-widest cursor-pointer select-none ' +
                  (isHighlighted
                    ? 'bg-black text-[#f5f4ee]'
                    : 'text-neutral-800 hover:bg-yellow-100')
                }
              >
                {/* Marker column: width-stable across rows so labels
                    don't shift when the selection changes. */}
                <span
                  aria-hidden="true"
                  className={
                    'inline-block w-3 text-center font-black ' +
                    (isSelected ? 'opacity-100' : 'opacity-0')
                  }
                >
                  &gt;
                </span>
                <span>{opt.label}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * Tiny SVG caret — flips on open. Inline so we don't pull a new icon
 * library for one glyph; matches the monospace weight of the trigger.
 */
function Caret({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 10 6"
      aria-hidden="true"
      className={'h-1.5 w-2.5 transition-transform ' + (open ? 'rotate-180' : '')}
    >
      <path
        d="M1 1l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  )
}
