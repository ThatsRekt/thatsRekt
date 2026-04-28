import type { EditEntity, PostDetail, ConfirmationEntity } from '../lib/queries'
import { AddressLabel } from './AddressLabel'
import { formatTimestamp, relativeTime } from '../lib/format'

// Synthesized "inception" event derived from the post's own creation
// data (no separate Inception entity exists on-chain — the PostCreated
// event IS the inception). Always rendered as the first row so a
// brand-new post still has a visible timeline.
interface InceptionData {
  poster: { id: string }
  /** When the post hit chain. */
  timestamp: string
  blockNumber: number
  attackerCount: number
  victimCount: number
}

type TimelineItem =
  | { kind: 'inception'; data: InceptionData }
  | { kind: 'confirmation'; data: ConfirmationEntity }
  | { kind: 'edit'; data: EditEntity }

interface TimelineProps {
  /** The post itself — used to derive the inception entry. */
  post: Pick<
    PostDetail,
    | 'poster'
    | 'createdAtTimestamp'
    | 'attackerLinks'
    | 'victimLinks'
  > & {
    /** Block number of post creation. Not on PostDetail directly today —
     *  if absent we still render an inception entry without a block. */
    createdAtBlock?: number
  }
  log: ConfirmationEntity[]
  edits: EditEntity[]
  chainSlug?: string
}

export function Timeline({ post, log, edits, chainSlug }: TimelineProps) {
  const inception: TimelineItem = {
    kind: 'inception',
    data: {
      poster: post.poster,
      timestamp: post.createdAtTimestamp,
      blockNumber: post.createdAtBlock ?? 0,
      attackerCount: post.attackerLinks.length,
      victimCount: post.victimLinks.length,
    },
  }

  const items: TimelineItem[] = [
    inception,
    ...log.map((v): TimelineItem => ({ kind: 'confirmation', data: v })),
    ...edits.map((e): TimelineItem => ({ kind: 'edit', data: e })),
  ].sort((a, b) => {
    // Inception always comes first (lowest block in practice; but if
    // blockNumber is unknown we still want it on top).
    if (a.kind === 'inception') return -1
    if (b.kind === 'inception') return 1
    return a.data.blockNumber - b.data.blockNumber
  })

  return (
    <ol className="space-y-4">
      {items.map((item, i) => {
        const ts =
          item.kind === 'inception' ? item.data.timestamp : item.data.timestamp
        const block = item.data.blockNumber
        return (
          <li
            key={item.kind === 'inception' ? 'inception' : `${item.kind}-${item.data.id}`}
            className="border-l-2 border-black pl-4"
          >
            <div className="flex flex-wrap items-baseline gap-2 text-[10px] uppercase tracking-widest text-neutral-700">
              <span className="font-black text-black">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span title={formatTimestamp(ts)}>
                {block > 0 ? `block ${block} · ` : ''}
                {relativeTime(ts)}
              </span>
            </div>
            {item.kind === 'inception' ? (
              <InceptionRow data={item.data} chainSlug={chainSlug} />
            ) : item.kind === 'confirmation' ? (
              <ConfirmationRow confirmation={item.data} chainSlug={chainSlug} />
            ) : (
              <EditRow edit={item.data} />
            )}
          </li>
        )
      })}
    </ol>
  )
}

function InceptionRow({
  data,
  chainSlug,
}: {
  data: InceptionData
  chainSlug?: string
}) {
  return (
    <p className="mt-1 text-sm">
      <span className="font-black uppercase tracking-tight text-red-600">★ posted</span>{' '}
      <span className="text-neutral-700">by</span>{' '}
      <AddressLabel addr={data.poster.id} chainSlug={chainSlug} />{' '}
      <span className="text-neutral-700">·</span>{' '}
      <span className="text-xs uppercase tracking-widest text-neutral-700">
        {data.attackerCount} attacker{data.attackerCount === 1 ? '' : 's'},{' '}
        {data.victimCount} victim{data.victimCount === 1 ? '' : 's'}
      </span>
    </p>
  )
}

function ConfirmationRow({ confirmation, chainSlug }: { confirmation: ConfirmationEntity; chainSlug?: string }) {
  const action = describeConfirmation(confirmation.oldDirection, confirmation.newDirection)
  return (
    <p className="mt-1 text-sm">
      <AddressLabel addr={confirmation.confirmer.id} chainSlug={chainSlug} />{' '}
      <span className={`font-black uppercase tracking-tight ${confirmationColor(confirmation.newDirection)}`}>
        {action.icon} {action.label}
      </span>
    </p>
  )
}

function EditRow({ edit }: { edit: EditEntity }) {
  return (
    <div className="mt-1 space-y-1">
      <p className="text-sm font-black uppercase tracking-tight">
        {describeEditKind(edit.kind)}
      </p>
      {edit.kind === 'AmendNote' && edit.newNote != null && (
        <p className="text-sm leading-relaxed text-neutral-800">{edit.newNote}</p>
      )}
      {edit.kind === 'AmendTitle' && edit.newTitle != null && (
        <p className="text-sm font-black leading-relaxed text-neutral-800">{edit.newTitle}</p>
      )}
      {edit.kind === 'AddAttackers' && edit.addedAttackers && (
        <ul className="space-y-0.5 text-xs font-mono">
          {edit.addedAttackers.map((a) => (
            <li key={a}>+ {a}</li>
          ))}
        </ul>
      )}
      {edit.kind === 'AddVictims' && edit.addedVictims && (
        <ul className="space-y-0.5 text-xs font-mono">
          {edit.addedVictims.map((v) => (
            <li key={v}>+ {v}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function describeConfirmation(
  oldDir: ConfirmationEntity['oldDirection'],
  newDir: ConfirmationEntity['newDirection'],
): { icon: string; label: string } {
  if (oldDir === 'None' && newDir === 'Up') return { icon: '↑', label: 'confirmed' }
  if (oldDir === 'None' && newDir === 'Down') return { icon: '↓', label: 'disconfirmed' }
  if (newDir === 'None') return { icon: '×', label: 'cleared their confirmation' }
  if (oldDir === 'Up' && newDir === 'Down')
    return { icon: '↓', label: 'switched to disconfirm' }
  if (oldDir === 'Down' && newDir === 'Up')
    return { icon: '↑', label: 'switched to confirm' }
  return { icon: '·', label: `${oldDir} → ${newDir}` }
}

function confirmationColor(newDir: string): string {
  if (newDir === 'None') return 'text-neutral-700'
  if (newDir === 'Up') return 'text-emerald-700'
  if (newDir === 'Down') return 'text-red-600'
  return 'text-neutral-700'
}

function describeEditKind(kind: EditEntity['kind']): string {
  switch (kind) {
    case 'AmendNote':
      return 'note amended'
    case 'AmendTitle':
      return 'title amended'
    case 'AddAttackers':
      return 'attackers added'
    case 'AddVictims':
      return 'victims added'
  }
}
