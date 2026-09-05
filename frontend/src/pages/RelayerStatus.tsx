import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatEther } from 'viem'
import { fetchContributors } from '../lib/queries'
import { liveIndexedChains, chainIdFromSlug } from '../lib/chains'
import { lookupContributor } from '../lib/contributors'
import { useRelayerActivity } from '../hooks/useRelayerActivity'
import { useRelayerGasBalances, type BalanceTarget } from '../hooks/useRelayerGasBalances'

const TOKEN_SESSION_KEY = 'relayerStatusAdminToken'

// Rough heuristic, not a precise SLA: below this, a detector is at real
// risk of not being able to submit its next tx. Native-token prices and
// typical tx cost vary a lot per chain, so this is deliberately
// conservative and meant to prompt a human look, not to be authoritative.
const LOW_GAS_THRESHOLD_WEI = 10n ** 16n // 0.01 native units

function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_SESSION_KEY)
  } catch {
    return null
  }
}

function storeToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_SESSION_KEY, token)
    else sessionStorage.removeItem(TOKEN_SESSION_KEY)
  } catch {
    // sessionStorage unavailable (private mode, etc.) — token just won't
    // survive a refresh. Not worth failing the page over.
  }
}

/**
 * Internal-only relayer/detector health page — not linked from nav
 * (see `App.tsx`'s route table). Reachable only via direct URL, and
 * gated behind an admin token checked server-side by Mesh's
 * `relayerActivity` resolver (see `mesh/src/relayerStatus.ts`).
 *
 * Gas balances are read straight from public RPC client-side — that data
 * is public chain state regardless of this page's gate (any wallet
 * balance is checkable on a block explorer). What the token actually
 * protects is the *convenience* of seeing every detector's activity in
 * one place, which Mesh doesn't otherwise expose in aggregate.
 */
export function RelayerStatus() {
  const [token, setToken] = useState<string | null>(() => readStoredToken())
  const [tokenInput, setTokenInput] = useState('')

  const { rows: activityRows, isLoading: activityLoading, isError: activityError } =
    useRelayerActivity(token)

  // Once the token turns out to be wrong, drop it rather than looping
  // failed requests forever.
  if (activityError && token) {
    storeToken(null)
    setToken(null)
  }

  const chainSlugs = useMemo(() => liveIndexedChains().map((c) => c.slug), [])

  const { data: contributorsByChain, isLoading: contributorsLoading } = useQuery({
    queryKey: ['relayerStatusContributors', chainSlugs.join(',')],
    queryFn: () => fetchContributors(chainSlugs),
    enabled: !!token,
    staleTime: 60_000,
  })

  const targets: BalanceTarget[] = useMemo(() => {
    if (!contributorsByChain) return []
    const out: BalanceTarget[] = []
    for (const group of contributorsByChain) {
      const chainId = chainIdFromSlug(group.chainSlug)
      if (!chainId) continue
      for (const c of group.active) {
        out.push({ chainId, chainSlug: group.chainSlug, address: c.address })
      }
    }
    return out
  }, [contributorsByChain])

  const { balances, isLoading: balancesLoading } = useRelayerGasBalances(targets)

  const activityByKey = useMemo(() => {
    const m = new Map<string, { postCount: number; lastActivityAt: string }>()
    for (const row of activityRows) {
      m.set(`${row.chainSlug}:${row.address.toLowerCase()}`, row)
    }
    return m
  }, [activityRows])

  if (!token) {
    return (
      <article className="max-w-md space-y-6">
        <header className="space-y-2 border-b-2 border-black pb-4">
          <h1 className="font-black uppercase tracking-tighter text-3xl leading-none">
            relayer status
          </h1>
          <p className="text-xs uppercase tracking-widest text-neutral-700">
            [internal — admin token required]
          </p>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            storeToken(tokenInput)
            setToken(tokenInput)
          }}
          className="space-y-3"
        >
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="admin token"
            aria-label="admin token"
            className="w-full border-2 border-black px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-600"
          />
          <button
            type="submit"
            disabled={!tokenInput}
            className="border-2 border-red-600 bg-red-600 text-white px-3 py-2 text-[11px] uppercase tracking-widest font-black hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            unlock
          </button>
        </form>
      </article>
    )
  }

  const isLoading = activityLoading || contributorsLoading || balancesLoading

  return (
    <article className="space-y-8">
      <header className="space-y-2 border-b-2 border-black pb-4 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
            relayer status
          </h1>
          <p className="text-xs uppercase tracking-widest text-neutral-700 mt-2">
            [gas balance · activity · per detector, per chain]
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            storeToken(null)
            setToken(null)
          }}
          className="border-2 border-black px-3 py-1 text-[11px] uppercase tracking-widest font-black hover:bg-yellow-100 shrink-0"
        >
          lock
        </button>
      </header>

      {isLoading && (
        <p className="text-sm uppercase tracking-widest text-neutral-600">loading…</p>
      )}

      <div className="overflow-x-auto border-2 border-black">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-black bg-yellow-100 uppercase tracking-widest text-[11px]">
              <th className="text-left px-3 py-2">detector</th>
              <th className="text-left px-3 py-2">chain</th>
              <th className="text-left px-3 py-2">gas balance</th>
              <th className="text-left px-3 py-2">posts</th>
              <th className="text-left px-3 py-2">last activity</th>
            </tr>
          </thead>
          <tbody className="divide-y-2 divide-black">
            {targets.map((t) => {
              const label = lookupContributor(t.chainSlug, t.address)
              const balance = balances.find(
                (b) => b.chainId === t.chainId && b.address.toLowerCase() === t.address.toLowerCase(),
              )
              const activity = activityByKey.get(`${t.chainSlug}:${t.address.toLowerCase()}`)
              const isLowGas =
                balance?.balanceWei !== null &&
                balance?.balanceWei !== undefined &&
                balance.balanceWei < LOW_GAS_THRESHOLD_WEI

              return (
                <tr key={`${t.chainSlug}:${t.address}`}>
                  <td className="px-3 py-2 font-mono text-xs">
                    {label?.name ?? t.address}
                  </td>
                  <td className="px-3 py-2">{t.chainSlug}</td>
                  <td className="px-3 py-2 font-mono">
                    {balance?.balanceWei != null ? (
                      <span className={isLowGas ? 'text-red-600 font-black' : ''}>
                        {Number(formatEther(balance.balanceWei)).toFixed(4)} {balance.symbol}
                        {isLowGas ? ' — low' : ''}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2">{activity?.postCount ?? '—'}</td>
                  <td className="px-3 py-2">
                    {activity?.lastActivityAt
                      ? new Date(activity.lastActivityAt).toLocaleString()
                      : '—'}
                  </td>
                </tr>
              )
            })}
            {targets.length === 0 && !isLoading && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-neutral-600">
                  no whitelisted detectors found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </article>
  )
}
