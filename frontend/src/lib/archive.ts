/**
 * Archive posts — pre-platform DeFi attacks.
 *
 * These are NOT on-chain. They're a curated dataset
 * (`data/historic-incidents.json`, copied to `frontend/src/data/`) that
 * the feed renders read-only beneath the live on-chain section.
 *
 * The shape mirrors the JSON schema documented in `data/README.md`. Any
 * field-level changes there must be reflected here — and vice versa.
 */
import incidentsRaw from '../data/historic-incidents.json'
import { CHAINS } from './chains'

export interface ArchivePost {
  /** Stable slug — `{protocol-slug}-{yyyy}[-{mm}]`. Used as the synthetic
   *  composite id `archive-{id}` in URLs. */
  readonly id: string
  readonly protocol: string
  /** Primary chain slug. Must be a key in `CHAINS` for badges/explorer
   *  links to resolve; archive-only chains are added there with
   *  `liveIndexed: false`. */
  readonly chain: string
  /** ISO 8601 timestamp of the attack itself. */
  readonly attackedAt: string
  readonly title: string
  /** Lowercased 0x-prefixed addresses. May be empty when an attacker
   *  was never publicly attributed. */
  readonly attackers: readonly string[]
  /** Protocol contract addresses. May be empty. */
  readonly victims: readonly string[]
  readonly note: string
  readonly sourceUrl: string
  readonly amountUsd: number
  /** Secondary chains for multi-chain incidents. */
  readonly chainsAffected?: readonly string[]
}

/** Cast the imported JSON to the typed shape. JSON imports come back
 *  loosely-typed by default; one cast at the boundary is cleaner than
 *  per-call assertions. */
const ALL_INCIDENTS: readonly ArchivePost[] = incidentsRaw as readonly ArchivePost[]

/** Chains the frontend can render (have an entry in `CHAINS`). Entries
 *  whose `chain` is unknown to the frontend (currently: solana) are
 *  filtered out at module load — they have no badge, no explorer, no
 *  way to render usefully. */
const RENDERABLE_INCIDENTS: readonly ArchivePost[] = ALL_INCIDENTS.filter(
  (i) => i.chain in CHAINS,
)

export type ArchiveSort = 'newest' | 'oldest'

interface SelectArchiveOpts {
  /** When set, only return incidents whose primary `chain` matches.
   *  `null` / `undefined` returns all chains. */
  readonly chainSlug?: string | null
  /** `newest` → DESC by `attackedAt`. `oldest` → ASC. */
  readonly sort?: ArchiveSort
}

/**
 * Pure helper. Filters and sorts the renderable archive set.
 *
 * Note: the dataset is small (~30 entries) and frozen at module load, so
 * we sort on every call rather than memoizing. If this ever grows large
 * enough to matter, wrap the result in a `useMemo` at the call site.
 */
export const selectArchive = (opts: SelectArchiveOpts = {}): readonly ArchivePost[] => {
  const { chainSlug, sort = 'newest' } = opts
  const filtered = chainSlug
    ? RENDERABLE_INCIDENTS.filter((i) => i.chain === chainSlug)
    : RENDERABLE_INCIDENTS
  // Defensive: copy before sort. The base array is conceptually
  // readonly; mutating it would corrupt subsequent calls.
  const copy = filtered.slice()
  copy.sort((a, b) => {
    const cmp = a.attackedAt.localeCompare(b.attackedAt)
    return sort === 'newest' ? -cmp : cmp
  })
  return copy
}

/** Derive the URL id used for archive detail pages. */
export const archivePostUrlId = (post: ArchivePost): string => `archive-${post.id}`

/** Inverse of `archivePostUrlId` — extract the slug if the id is an
 *  archive id, or return null. */
export const archiveSlugFromUrlId = (urlId: string): string | null => {
  const prefix = 'archive-'
  return urlId.startsWith(prefix) ? urlId.slice(prefix.length) : null
}

/** Look up a single archive entry by slug (no `archive-` prefix). */
export const findArchiveBySlug = (slug: string): ArchivePost | null =>
  RENDERABLE_INCIDENTS.find((i) => i.id === slug) ?? null

/** Compact USD formatter — "$625M", "$1.2B", "$60M". The dataset's
 *  `amountUsd` is always a round-ish whole-dollar figure; we never need
 *  cents or sub-million precision. */
export const formatAmountUsd = (amountUsd: number): string => {
  if (amountUsd >= 1_000_000_000) {
    const v = amountUsd / 1_000_000_000
    return `$${v >= 10 ? v.toFixed(0) : v.toFixed(1)}B`
  }
  if (amountUsd >= 1_000_000) {
    const v = amountUsd / 1_000_000
    return `$${v >= 10 ? v.toFixed(0) : v.toFixed(1)}M`
  }
  if (amountUsd >= 1_000) {
    return `$${(amountUsd / 1_000).toFixed(0)}K`
  }
  return `$${amountUsd}`
}
