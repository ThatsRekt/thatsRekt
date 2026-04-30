import { useEffect, useState } from 'react'
import { BASE_BLOCK_TIME_SECONDS, type IndexerStatus } from '../lib/queries'

interface StalenessIndicatorProps {
  status: IndexerStatus | undefined
  isError: boolean
}

type Tone = 'live' | 'lagging' | 'stale' | 'unknown'

interface ToneSpec {
  /** Tailwind bg-* class for the dot. */
  dotClass: string
  /** Lowercase brutalist label, e.g. "live", "lagging 14s". */
  label: string
}

/** Lag thresholds (in blocks). Base is ~2s/block, so 5 blocks ≈ 10s, 30 ≈ 1min. */
const LAG_GREEN_MAX = 5
const LAG_AMBER_MAX = 30

const formatLagSeconds = (lag: number): string => {
  const seconds = lag * BASE_BLOCK_TIME_SECONDS
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return `${hours}h`
}

const computeTone = (status: IndexerStatus | undefined, isError: boolean): ToneSpec => {
  if (isError || !status) {
    return { dotClass: 'bg-neutral-400', label: 'status unknown' }
  }
  const { lag } = status
  if (lag <= LAG_GREEN_MAX) {
    return { dotClass: 'bg-green-500', label: 'live' }
  }
  if (lag <= LAG_AMBER_MAX) {
    return { dotClass: 'bg-amber-500', label: `lagging ${formatLagSeconds(lag)}` }
  }
  return { dotClass: 'bg-red-600', label: `stale ${formatLagSeconds(lag)}` }
}

const formatChecked = (lastFetchedAt: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - lastFetchedAt) / 1000))
  if (seconds < 5) return 'checked just now'
  if (seconds < 90) return `checked ${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `checked ${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return `checked ${hours}h ago`
}

/**
 * Hook driving a 1-second wall-clock tick so the "checked Ns ago" text
 * updates without waiting for the next 15s status refetch. Cheap — one
 * setInterval, no other state.
 */
function useWallClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

/**
 * Lowercase brutalist staleness indicator: colored dot + label + tertiary
 * "checked Ns ago" line.
 *
 * Three states for the dot:
 *   green  → indexer ≤ 5 blocks behind chain tip (~10s on Base)
 *   amber  → 6-30 blocks (~10s-1min)
 *   red    → > 30 blocks (1min+)
 *   gray   → couldn't fetch chain tip or indexer height
 */
export function StalenessIndicator({ status, isError }: StalenessIndicatorProps) {
  const tone = computeTone(status, isError)
  const now = useWallClock()
  const checked = status ? formatChecked(status.lastFetchedAt, now) : null

  return (
    <div
      role="status"
      aria-live="polite"
      className="inline-flex items-baseline gap-2 text-[10px] uppercase tracking-widest text-neutral-700"
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 rounded-full ${tone.dotClass}`}
        />
        <span>[{tone.label}]</span>
      </span>
      {checked && (
        <span className="text-neutral-500 normal-case tracking-normal text-[10px]">
          {checked}
        </span>
      )}
    </div>
  )
}
