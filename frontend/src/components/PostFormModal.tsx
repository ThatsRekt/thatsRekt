import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { getAddress, isAddress } from 'viem'
import { useAccount, useSwitchChain } from 'wagmi'
import { CHAINS, explorerTxUrl, type FrontendChain } from '../lib/chains'
import { usePost } from '../hooks/usePost'
import type { SupportedChainId } from '../lib/contracts'

/**
 * Post composer modal.
 *
 * Brutalist styling matches `WhitelistGateModal` — same border / shadow
 * vocabulary, `bg-[#f5f4ee]` body, lowercase bracketed labels. Lives in
 * its own component (vs a slot inside the gate modal) because the form
 * state is non-trivial and we want it isolated from the connect flow.
 *
 * Submission lifecycle is owned by `usePost`:
 *
 *   1. user fills form → submit button enabled when valid
 *   2. click submit → `submit({...})` fires the wallet popup
 *      (`isBroadcasting=true`, label = "signing…")
 *   3. tx broadcast → `isMining=true`, label = "confirming…"
 *   4. tx confirmed → `isSuccess=true`, form swaps to a success panel
 *
 * Modal does NOT auto-close on success — operator wants the user to see
 * the explorer link and decide explicitly between "view it" and "post
 * another". The frame pattern is duplicated inline (not extracted) per
 * the spec; refactor is a follow-up.
 */
export function PostFormModal({
  open,
  onClose,
  whitelistedChains,
}: {
  open: boolean
  onClose: () => void
  /** Chain IDs the connected user is whitelisted on. Form selects from this set. */
  whitelistedChains: readonly number[]
}) {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Close on Escape; lock body scroll while open. Same pattern as
  // WhitelistGateModal — duplicated rather than extracted because both
  // modals are short-lived and the shared shape isn't earning its
  // abstraction yet (per spec).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  // Focus the close button on first paint so Escape isn't the only exit.
  useEffect(() => {
    if (!open) return
    dialogRef.current?.querySelector<HTMLButtonElement>('[data-close]')?.focus()
  }, [open])

  // Defensive: parent should not open this with an empty chain set.
  // Returning null keeps the surface a no-op rather than rendering an
  // unusable form (no chain → can't submit anyway).
  if (!open || whitelistedChains.length === 0) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="post-form-modal-title"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 py-12 sm:py-20 overflow-y-auto"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg border-2 border-black bg-[#f5f4ee] shadow-[6px_6px_0_0_#000]"
      >
        <header className="flex items-center justify-between border-b-2 border-black px-4 py-2 bg-black text-[#f5f4ee]">
          <h2
            id="post-form-modal-title"
            className="text-[11px] uppercase tracking-widest font-black"
          >
            [post]
          </h2>
          <button
            type="button"
            data-close
            onClick={onClose}
            aria-label="close"
            className="text-[#f5f4ee] hover:text-red-500 -mr-1 px-1 leading-none text-lg"
          >
            ✕
          </button>
        </header>
        <div className="px-5 py-5">
          <PostFormBody whitelistedChains={whitelistedChains} onClose={onClose} />
        </div>
      </div>
    </div>
  )
}

/**
 * Inner body. Owns all form state. Split from the modal frame so the
 * frame's effects (scroll lock / Escape) don't re-mount the form on every
 * render and clobber typed input.
 */
function PostFormBody({
  whitelistedChains,
  onClose: _onClose,
}: {
  whitelistedChains: readonly number[]
  onClose: () => void
}) {
  const post = usePost()

  // Wallet chain reconciliation. The selected chain in the form may not
  // match the chain the user's wallet is currently pointed at; in that
  // case wagmi's `writeContract` would auto-prompt with a confusing
  // "current chain (id: X) does not match target (id: Y – undefined)"
  // error. We surface it as a deliberate first-class step instead.
  const { chainId: walletChainId } = useAccount()
  const { switchChain, isPending: isSwitchingChain, error: switchError } =
    useSwitchChain()

  // Default chain = first option. The spec says the form selects from
  // `whitelistedChains`; if exactly one option, render as a read-only
  // label. Picking the first is deterministic and matches user intent
  // for the single-chain case.
  const [chainId, setChainId] = useState<number>(whitelistedChains[0])

  // If the whitelistedChains set changes shape (e.g. a slow-resolving
  // per-chain read flips a second chain on after mount), keep the selected
  // chain valid. We don't auto-jump unless the current selection is no
  // longer in the set — preserves user choice.
  useEffect(() => {
    if (!whitelistedChains.includes(chainId)) {
      setChainId(whitelistedChains[0])
    }
  }, [whitelistedChains, chainId])

  const [title, setTitle] = useState('')
  const [attackers, setAttackers] = useState<readonly string[]>([''])
  const [victims, setVictims] = useState<readonly string[]>([''])
  const [note, setNote] = useState('')
  const [attackedAt, setAttackedAt] = useState<string>(() => utcNowForPicker())
  /** Surfaces validation messages on submit when the form has bad input. */
  const [submitError, setSubmitError] = useState<string | null>(null)

  // ---- derived: byte counts and address validity ----------------------
  // Title length is enforced on-chain in BYTES (UTF-8), not chars. A
  // multi-byte char like emoji costs 4 bytes; a naive .length would let
  // the user submit a tx that reverts.
  const titleBytes = useMemo(
    () => new Blob([title]).size,
    [title],
  )
  const cleanAttackers = useMemo(
    () => attackers.map((a) => a.trim()).filter((a) => a.length > 0),
    [attackers],
  )
  const cleanVictims = useMemo(
    () => victims.map((v) => v.trim()).filter((v) => v.length > 0),
    [victims],
  )
  const allAddrsValid = useMemo(
    () => [...cleanAttackers, ...cleanVictims].every((a) => isAddress(a)),
    [cleanAttackers, cleanVictims],
  )
  const totalAddrs = cleanAttackers.length + cleanVictims.length

  // ---- form validity --------------------------------------------------
  const titleValid = title.trim().length > 0 && titleBytes <= 200
  const attackedAtBigint = useMemo(
    () => parseUtcLocalToUnixSeconds(attackedAt),
    [attackedAt],
  )
  const nowSeconds = useMemo(() => BigInt(Math.floor(Date.now() / 1000)), [])
  const attackedAtValid =
    attackedAtBigint !== null &&
    attackedAtBigint > 0n &&
    // Allow a small clock-skew tolerance — the picker has minute
    // granularity, so a "now" pick can land a few seconds in the future
    // relative to the next block. Cap by the current frontend clock; the
    // contract checks against block.timestamp at execution time, which
    // will have advanced.
    attackedAtBigint <= nowSeconds + 60n
  const addrCountValid = totalAddrs <= 100
  const noteValid = note.length <= 4000

  const formValid =
    titleValid && allAddrsValid && addrCountValid && attackedAtValid && noteValid

  // Wallet may be pointed at a chain that's not in our wagmi config
  // (then `walletChainId` is undefined here — wagmi only reports
  // configured chains) or at a different supported chain than the form
  // selected. Both cases require an explicit switch before submit.
  const chainMismatch = walletChainId !== chainId
  const submitDisabled =
    !formValid || chainMismatch || post.isBroadcasting || post.isMining

  // ---- success state --------------------------------------------------
  if (post.isSuccess && post.hash && post.submittedChainId !== undefined) {
    return (
      <SuccessPanel
        hash={post.hash}
        chainId={post.submittedChainId}
        onPostAnother={() => {
          post.reset()
          // Reset form fields back to defaults so the user can start
          // fresh. Keep the chain selection — most users will post on
          // the same chain twice in a row.
          setTitle('')
          setAttackers([''])
          setVictims([''])
          setNote('')
          setAttackedAt(utcNowForPicker())
          setSubmitError(null)
        }}
      />
    )
  }

  // ---- mining state ---------------------------------------------------
  // Tx is broadcast (we have a hash) but hasn't reached the chain's
  // confirm threshold. Swap the form body for a dedicated panel with a
  // spinner — keeps the user oriented and offers an explorer-link
  // escape hatch in case they'd rather verify in their wallet UI.
  if (post.isMining && post.hash && post.submittedChainId !== undefined) {
    return (
      <PendingPanel
        hash={post.hash}
        chainId={post.submittedChainId}
      />
    )
  }

  // ---- handlers -------------------------------------------------------
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setSubmitError(null)

    if (!titleValid) {
      setSubmitError('Title is required and must be ≤ 200 bytes.')
      return
    }
    if (!allAddrsValid) {
      setSubmitError('One or more addresses are invalid.')
      return
    }
    if (!addrCountValid) {
      setSubmitError('attackers + victims must be ≤ 100 addresses.')
      return
    }
    if (!noteValid) {
      setSubmitError('Note must be ≤ 4000 characters.')
      return
    }
    if (!attackedAtValid || attackedAtBigint === null) {
      setSubmitError('attackedAt must be in the past.')
      return
    }

    // Belt-and-suspenders checksum at submit time. The on-blur path
    // already converts addresses as the user moves between fields, but
    // a paste-then-immediately-click flow can land here with lowercase
    // bytes still in the array. The contract doesn't care, but downstream
    // (explorers, indexers, the Telegram bot) is friendlier with EIP-55.
    const checksumAll = (addrs: readonly string[]) =>
      addrs.map((a) => getAddress(a)) as readonly `0x${string}`[]

    post.submit({
      chainId,
      title: title.trim(),
      attackers: checksumAll(cleanAttackers),
      victims: checksumAll(cleanVictims),
      note,
      attackedAt: attackedAtBigint,
    })
  }

  const submitLabel = post.isBroadcasting
    ? '[ signing… ]'
    : post.isMining
      ? '[ confirming… ]'
      : '[ submit ]'

  // viem error objects expose `shortMessage` (one-line) alongside the
  // verbose `message` (full stack). Prefer the short form when available.
  const errorMessage = post.error
    ? ((post.error as Error & { shortMessage?: string }).shortMessage ??
      post.error.message)
    : null

  // datetime-local `max` — keep it pinned to "now (UTC)" so the picker
  // can't overshoot the present. Recomputing on every render is cheap
  // and avoids a stale ceiling if the modal stays open across midnight.
  const maxAttackedAt = utcNowForPicker()

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* ------------------------------------------------------------ */}
      {/* chain                                                         */}
      {/* ------------------------------------------------------------ */}
      <div className="space-y-1">
        <label className="block text-[11px] uppercase tracking-widest font-black">
          [chain]
        </label>
        <ChainPicker
          chainIds={whitelistedChains}
          value={chainId}
          onChange={setChainId}
        />
      </div>

      {/* ------------------------------------------------------------ */}
      {/* title                                                         */}
      {/* ------------------------------------------------------------ */}
      <div className="space-y-1">
        <label
          htmlFor="post-title"
          className="block text-[11px] uppercase tracking-widest font-black"
        >
          [title]
        </label>
        <input
          id="post-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className="w-full border-2 border-black bg-white px-3 py-2 text-sm font-mono"
          placeholder="short summary"
        />
        <p
          className={
            'text-[10px] uppercase tracking-widest ' +
            (titleBytes > 200 ? 'text-red-700' : 'text-neutral-600')
          }
        >
          {titleBytes}/200 bytes
        </p>
      </div>

      {/* ------------------------------------------------------------ */}
      {/* attackers                                                     */}
      {/* ------------------------------------------------------------ */}
      <AddressList
        legend="[attackers]"
        rows={attackers}
        onChange={setAttackers}
      />

      {/* ------------------------------------------------------------ */}
      {/* victims                                                       */}
      {/* ------------------------------------------------------------ */}
      <AddressList
        legend="[victims]"
        rows={victims}
        onChange={setVictims}
      />

      {!addrCountValid && (
        <p className="text-[10px] uppercase tracking-widest text-red-700 border-2 border-red-700 bg-red-50 px-3 py-2">
          attackers + victims must be ≤ 100 ({totalAddrs} given)
        </p>
      )}

      {/* ------------------------------------------------------------ */}
      {/* attackedAt — UTC                                              */}
      {/* ------------------------------------------------------------ */}
      <div className="space-y-1">
        <label
          htmlFor="post-attacked-at"
          className="block text-[11px] uppercase tracking-widest font-black"
        >
          [when (utc)]
        </label>
        <input
          id="post-attacked-at"
          type="datetime-local"
          value={attackedAt}
          onChange={(e) => setAttackedAt(e.target.value)}
          max={maxAttackedAt}
          required
          className="w-full border-2 border-black bg-white px-3 py-2 text-sm font-mono"
        />
        <p className="text-[10px] uppercase tracking-widest text-neutral-600">
          all times utc — global instant, no local-tz ambiguity
        </p>
        {!attackedAtValid && attackedAt !== '' && (
          <p className="text-[10px] uppercase tracking-widest text-red-700">
            must be in the past
          </p>
        )}
      </div>

      {/* ------------------------------------------------------------ */}
      {/* note                                                          */}
      {/* ------------------------------------------------------------ */}
      <div className="space-y-1">
        <label
          htmlFor="post-note"
          className="block text-[11px] uppercase tracking-widest font-black"
        >
          [note]
        </label>
        <textarea
          id="post-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          className="w-full border-2 border-black bg-white px-3 py-2 text-sm font-mono"
          placeholder="optional context (links, tx hashes, etc.)"
        />
        <p
          className={
            'text-[10px] uppercase tracking-widest ' +
            (note.length > 4000 ? 'text-red-700' : 'text-neutral-600')
          }
        >
          {note.length}/4000
        </p>
      </div>

      {/* ------------------------------------------------------------ */}
      {/* submit OR switch-chain                                        */}
      {/* ------------------------------------------------------------ */}
      <div className="space-y-2 pt-2">
        {chainMismatch ? (
          <SwitchChainPrompt
            walletChainId={walletChainId}
            targetChainId={chainId}
            onSwitch={() => switchChain({ chainId: chainId as SupportedChainId })}
            isPending={isSwitchingChain}
            error={switchError}
          />
        ) : (
          <button
            type="submit"
            disabled={submitDisabled}
            className="w-full border-2 border-red-600 bg-red-600 text-white px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-red-700 hover:border-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitLabel}
          </button>
        )}

        {submitError && (
          <p className="text-xs text-red-700 border-2 border-red-700 bg-red-50 px-3 py-2 uppercase tracking-widest">
            {submitError}
          </p>
        )}
        {errorMessage && (
          <p className="text-xs text-red-700 border-2 border-red-700 bg-red-50 px-3 py-2 break-words">
            {errorMessage}
          </p>
        )}
      </div>
    </form>
  )
}

/**
 * Pre-submit prompt shown when the wallet's current chain doesn't match
 * the form's selected chain. Replaces the submit button until the user
 * approves the switch in their wallet — clearer than letting wagmi
 * auto-prompt mid-broadcast and surfacing a viem `ChainMismatchError`.
 */
function SwitchChainPrompt({
  walletChainId,
  targetChainId,
  onSwitch,
  isPending,
  error,
}: {
  walletChainId: number | undefined
  targetChainId: number
  onSwitch: () => void
  isPending: boolean
  error: Error | null
}) {
  const target = chainById(targetChainId)
  const targetLabel = target?.name ?? `chain ${targetChainId}`
  const walletLabel = walletChainId
    ? (chainById(walletChainId)?.name ?? `chain ${walletChainId}`)
    : 'an unsupported chain'

  return (
    <div className="space-y-2 border-2 border-amber-700 bg-amber-50 px-3 py-3">
      <p className="text-[10px] uppercase tracking-widest font-black text-amber-800">
        [chain mismatch]
      </p>
      <p className="text-xs leading-relaxed text-neutral-800">
        Wallet is on{' '}
        <span className="font-mono">{walletLabel}</span>. Switch to{' '}
        <span className="font-mono font-black">{targetLabel}</span> before
        posting.
      </p>
      <button
        type="button"
        onClick={onSwitch}
        disabled={isPending}
        className="w-full border-2 border-amber-700 bg-amber-700 text-white px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-amber-800 hover:border-amber-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isPending
          ? `[ switching to ${targetLabel}… ]`
          : `[ switch to ${targetLabel} ]`}
      </button>
      {error && (
        <p className="text-xs text-red-700 break-words">
          {(error as Error & { shortMessage?: string }).shortMessage ??
            error.message}
        </p>
      )}
    </div>
  )
}

/**
 * Chain picker: segmented buttons when 2+ options, read-only label when 1.
 * Visually a row of bracketed pills; the active chain inverts to black/cream.
 */
function ChainPicker({
  chainIds,
  value,
  onChange,
}: {
  chainIds: readonly number[]
  value: number
  onChange: (next: number) => void
}) {
  // Single-chain case → render a static badge instead of an interactive
  // chooser. Reduces noise when there's nothing to choose.
  if (chainIds.length === 1) {
    const chain = chainById(chainIds[0])
    return (
      <div className="inline-flex items-center border-2 border-black bg-white px-3 py-2 text-xs font-mono uppercase tracking-widest">
        {chain?.badge ?? `chain ${chainIds[0]}`}
      </div>
    )
  }

  return (
    <div role="radiogroup" aria-label="chain" className="flex flex-wrap gap-2">
      {chainIds.map((id) => {
        const chain = chainById(id)
        const active = id === value
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(id)}
            className={
              'border-2 border-black px-3 py-2 text-xs font-mono uppercase tracking-widest transition-colors ' +
              (active
                ? 'bg-black text-[#f5f4ee]'
                : 'bg-white text-neutral-800 hover:bg-yellow-100')
            }
          >
            {chain?.badge ?? `chain ${id}`}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Repeating-row address list. Each row is a single-line input with a
 * remove button; an `[+ add address]` button adds a fresh empty row.
 *
 * Empty rows are tolerated in-form (so the user can blank one out
 * without losing focus) — they're stripped at submit time. We always
 * keep at least one row mounted so the user has something to type into.
 */
function AddressList({
  legend,
  rows,
  onChange,
}: {
  legend: string
  rows: readonly string[]
  onChange: (next: readonly string[]) => void
}) {
  const setRow = (idx: number, value: string) => {
    onChange(rows.map((r, i) => (i === idx ? value : r)))
  }
  // On blur: if the row has a valid hex address, replace it with its
  // EIP-55 checksum. Saves the user from worrying about case while
  // typing, and ensures the bytes we send on-chain are display-correct
  // (the contract doesn't care, but downstream consumers and explorers do).
  const checksumRow = (idx: number) => {
    const row = rows[idx]?.trim()
    if (!row || !isAddress(row)) return
    const cs = getAddress(row)
    if (cs !== rows[idx]) onChange(rows.map((r, i) => (i === idx ? cs : r)))
  }
  const removeRow = (idx: number) => {
    // Always preserve at least one row; clear the last instead of
    // unmounting it so the user has somewhere to type next.
    if (rows.length === 1) {
      onChange([''])
      return
    }
    onChange(rows.filter((_, i) => i !== idx))
  }
  const addRow = () => onChange([...rows, ''])

  return (
    <fieldset className="space-y-1">
      <legend className="block text-[11px] uppercase tracking-widest font-black">
        {legend}
      </legend>
      <div className="space-y-2">
        {rows.map((row, idx) => {
          const trimmed = row.trim()
          // Only flag invalid for non-empty rows — an empty row is an
          // intermediate state, not an error. The submit validator
          // collapses empties before checking validity.
          const showInvalid = trimmed.length > 0 && !isAddress(trimmed)
          return (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="text"
                value={row}
                onChange={(e) => setRow(idx, e.target.value)}
                onBlur={() => checksumRow(idx)}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                className={
                  'flex-1 border-2 bg-white px-3 py-2 text-sm font-mono ' +
                  (showInvalid ? 'border-red-700' : 'border-black')
                }
              />
              <button
                type="button"
                onClick={() => removeRow(idx)}
                aria-label="remove address"
                className="border-2 border-black bg-white px-2 py-2 text-xs font-black hover:bg-red-50 hover:border-red-700 hover:text-red-700"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        onClick={addRow}
        className="mt-2 border-2 border-black bg-white px-3 py-1 text-[11px] uppercase tracking-widest font-black hover:bg-yellow-100"
      >
        [+ add address]
      </button>
    </fieldset>
  )
}

/**
 * Post-confirmation panel. Replaces the form body once the tx is mined.
 * Includes a "view post" link to the chain's feed (we don't yet parse
 * the new post id from the tx logs — that's a follow-up).
 */
function SuccessPanel({
  hash,
  chainId,
  onPostAnother,
}: {
  hash: `0x${string}`
  chainId: number
  onPostAnother: () => void
}) {
  const chain = chainById(chainId)
  const txUrl = chain ? explorerTxUrl(chain, hash) : undefined
  // Feed lives at `/`. Chain query param is currently informational —
  // the feed page reads it for a default filter when present. No-op
  // gracefully if the param is unknown.
  const feedUrl = chain ? `/?chain=${chain.slug}` : '/'

  return (
    <div className="space-y-4">
      <p className="text-[11px] uppercase tracking-widest font-black text-emerald-700">
        [ posted ]
      </p>
      <p className="text-sm leading-relaxed text-neutral-800">
        Tx confirmed on{' '}
        <span className="font-mono uppercase">{chain?.name ?? `chain ${chainId}`}</span>
        . Indexer typically catches up in ~10–30s.
      </p>
      <div className="flex flex-wrap gap-2">
        {txUrl && (
          <a
            href={txUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="border-2 border-black bg-white px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-yellow-100 transition-colors"
          >
            view tx ↗
          </a>
        )}
        <a
          href={feedUrl}
          className="border-2 border-black bg-white px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-yellow-100 transition-colors"
        >
          view feed ↗
        </a>
        <button
          type="button"
          onClick={onPostAnother}
          className="border-2 border-red-600 bg-red-600 text-white px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-red-700 hover:border-red-700 transition-colors"
        >
          post another
        </button>
      </div>
    </div>
  )
}

/**
 * In-flight pending panel. Shown after the wallet has signed and the
 * tx has a hash, but before it has reached the chain-specific confirm
 * threshold. Replaces the form body for the duration so the user has
 * a clean "we're working on it" view rather than a frozen submit button.
 *
 * Includes a live spinner (CSS-only) and a click-through to the explorer
 * for users who want to verify against their wallet UI in parallel.
 */
function PendingPanel({
  hash,
  chainId,
}: {
  hash: `0x${string}`
  chainId: number
}) {
  const chain = chainById(chainId)
  const txUrl = chain ? explorerTxUrl(chain, hash) : undefined

  return (
    <div className="space-y-4 border-2 border-black bg-white px-4 py-4">
      <div className="flex items-center gap-3">
        <Spinner />
        <p className="text-[11px] uppercase tracking-widest font-black">
          [ confirming on {chain?.name ?? `chain ${chainId}`}… ]
        </p>
      </div>
      <p className="text-xs leading-relaxed text-neutral-800">
        Waiting for the chain to reach the safe-confirm threshold. This
        is normally a few seconds on L2 rollups, longer on L1 mainnet.
        You can close this modal — the tx already broadcast.
      </p>
      {txUrl && (
        <a
          href={txUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 border-2 border-black bg-white px-3 py-2 text-xs uppercase tracking-widest font-black hover:bg-yellow-100 transition-colors"
        >
          view tx in explorer ↗
        </a>
      )}
    </div>
  )
}

/** Lightweight CSS spinner — no extra deps, scales with current font size. */
function Spinner() {
  return (
    <span
      role="status"
      aria-label="loading"
      className="inline-block h-4 w-4 animate-spin border-2 border-black border-t-transparent rounded-full"
    />
  )
}

// ---- helpers ----------------------------------------------------------

/**
 * Lookup a `FrontendChain` by chainId. The frontend `CHAINS` registry is
 * keyed by slug, so we scan values. Small set (< 10 today), so an O(n)
 * scan is fine and avoids maintaining a parallel by-id index.
 */
function chainById(chainId: number): FrontendChain | undefined {
  for (const c of Object.values(CHAINS)) {
    if (c.chainId === chainId) return c
  }
  return undefined
}

/**
 * Build a `datetime-local`-compatible "now in UTC" string. Returns
 * `YYYY-MM-DDTHH:MM` representing the current wall clock time in UTC.
 *
 * Why UTC: an attack timestamp is a globally agreed instant; surfacing
 * it in the user's local timezone makes the form ambiguous (every poster
 * picks "now" in a different offset). The label calls out UTC explicitly
 * and we parse the string as UTC on submit.
 */
function utcNowForPicker(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  )
}

/**
 * Parse a `datetime-local` value as UTC, returning unix seconds. The
 * input string has no timezone suffix (`YYYY-MM-DDTHH:MM`); we append
 * `:00Z` so `Date.parse` treats it as UTC instead of the browser's local
 * timezone. Returns `null` on unparseable input.
 */
function parseUtcLocalToUnixSeconds(value: string): bigint | null {
  if (!value) return null
  const ms = Date.parse(`${value}:00Z`)
  if (Number.isNaN(ms)) return null
  return BigInt(Math.floor(ms / 1000))
}
