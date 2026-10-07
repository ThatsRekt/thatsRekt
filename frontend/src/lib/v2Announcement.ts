import { slugify } from '../components/DocsTOC'

/**
 * Public v2 teaser. Copy is the visitor-facing slice of the intake
 * redesign (docs/intake-redesign.md, D1-D88). Nothing here is live.
 *
 * The feed banner and the docs section import these so the two links
 * cannot drift apart.
 */

export const V2_ANNOUNCEMENT_ID = 'v2-announcement'

export const V2_DOCS_HEADING = 'coming in v2'

/** Must stay equal to slugify(V2_DOCS_HEADING). The docs TOC uses that. */
export const V2_DOCS_SECTION_ID = slugify(V2_DOCS_HEADING)

export const V2_DOCS_HREF = `/docs#${V2_DOCS_SECTION_ID}`

export const V2_FEED_HREF = `/#${V2_ANNOUNCEMENT_ID}`

export const V2_TOC_ENTRY = {
  id: V2_DOCS_SECTION_ID,
  label: 'coming in v2',
} as const

export interface V2Feature {
  readonly title: string
  readonly body: string
}

/**
 * What a visitor can expect. Gasless reports (D1), channels (D57, D74),
 * API request status (D19), in-app edits (D81), and the same registry
 * address with scores carried over (ADR 0004). AI coverage is the
 * public framing of the Jev checks, not a model name.
 */
export const V2_FEATURES: readonly V2Feature[] = [
  {
    title: 'Gasless',
    body: 'V2 is going gasless. The new API takes the report, so guardians do not send the transaction themselves.',
  },
  {
    title: 'AI-powered',
    body: 'Everything in v2 runs on the latest AI models.',
  },
  {
    title: 'Channels',
    body: 'main stays the public hack feed. A community can have its own channel, with its own guardians and votes, and anyone can follow that channel from chain events.',
  },
  {
    title: 'A status for every post',
    body: 'The API shows where each post is: submitted, checking, duplicate, on-chain, or failed.',
  },
  {
    title: 'Edit from the site',
    body: 'Edits go through the API. The reporting guardian can change the title or note, or add addresses, without sending a raw transaction.',
  },
  {
    title: 'Same address for integrators',
    body: 'The registry proxy does not move. attackerScore and isVictim keep their history. Older posts stay in the feed.',
  },
]
