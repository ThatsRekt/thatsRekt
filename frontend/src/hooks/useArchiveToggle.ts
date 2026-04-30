import { useEffect, useState } from 'react'

const STORAGE_KEY = 'thatsrekt:showArchive'

/**
 * Whether the feed renders the archive section beneath the live one.
 * Default `true` — first-time visitors see archives by design (the
 * launch-day case where the live feed is empty).
 *
 * Stored as `'1'` / `'0'` so the value is human-readable in devtools.
 */
function readInitial(): boolean {
  if (typeof window === 'undefined') return true
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return true
    return raw !== '0'
  } catch {
    return true
  }
}

export function useArchiveToggle(): {
  showArchive: boolean
  setShowArchive: (next: boolean) => void
} {
  const [showArchive, setShowArchiveState] = useState<boolean>(readInitial)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, showArchive ? '1' : '0')
    } catch {
      // localStorage unavailable (private mode etc.) — ignore
    }
  }, [showArchive])

  return { showArchive, setShowArchive: setShowArchiveState }
}
