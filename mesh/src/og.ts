/**
 * Server-side Open Graph / Twitter Card renderer for individual posts.
 *
 * Why this lives in Mesh: the frontend is a Vite SPA whose meta tags are
 * baked into the static `index.html`. Social-media crawlers (Twitterbot,
 * Discordbot, Slackbot, …) don't run JS, so they never see per-post
 * metadata when a deep link is shared. Mesh already owns the read API
 * and is internet-reachable; intercepting `/post/:chain/:postId` here
 * lets us emit a tiny HTML page with proper meta tags AND a JS redirect
 * back to the SPA route. Crawlers see meta. Browsers run the redirect.
 *
 * The same handler is used for both audiences — no User-Agent sniffing
 * needed for correctness. UA detection is only used to pick which
 * canonical URL to advertise (the SPA redirect target is identical
 * either way; the `og:url` is what changes).
 *
 * Data path: per-chain Subsquid GraphQL endpoint is queried directly
 * (skipping the stitched-schema prefix layer) — we already know the
 * chain from the URL and the squid's `postById` shape is stable across
 * chains.
 */
import { z } from 'zod'

import type { ChainEntry, ChainSlug } from './chains.js'

// ---------------------------------------------------------------------------
// Wire shapes — only what we actually render. Anything beyond this is
// silently dropped by zod, which is the desired behavior at the boundary.
// ---------------------------------------------------------------------------

const RawAddressId = z.object({ id: z.string() })
const RawAddressLink = z.object({ address: RawAddressId })

const RawPost = z.object({
  id: z.string(),
  title: z.string(),
  note: z.string(),
  poster: RawAddressId,
  attackedAt: z.string(),
  createdAtTimestamp: z.string(),
  confirmations: z.number().int(),
  disconfirmations: z.number().int(),
  netScore: z.number().int(),
  removed: z.boolean(),
  attackerLinks: z.array(RawAddressLink),
  victimLinks: z.array(RawAddressLink),
})
type RawPost = z.infer<typeof RawPost>

const FetchPostByIdResponse = z.object({
  postById: RawPost.nullable(),
})

const POST_BY_ID_QUERY = /* GraphQL */ `
  query PostById($id: String!) {
    postById(id: $id) {
      id
      title
      note
      poster { id }
      attackedAt
      createdAtTimestamp
      confirmations
      disconfirmations
      netScore
      removed
      attackerLinks { address { id } }
      victimLinks { address { id } }
    }
  }
`

// ---------------------------------------------------------------------------
// Crawler detection
// ---------------------------------------------------------------------------
//
// Conservative list — when in doubt, treat as a crawler. A false-positive
// (browser flagged as crawler) is harmless because both code paths emit
// the same meta tags; only the redirect `<script>` is skipped, and we
// also emit an HTML `<meta refresh>` as belt-and-suspenders so even
// "crawlers" with reduced JS still bounce to the SPA.
//
// keep this list narrow + lowercase. Substring match.
const CRAWLER_UA_FRAGMENTS: readonly string[] = Object.freeze([
  'twitterbot',
  'discordbot',
  'facebookexternalhit',
  'facebot',
  'linkedinbot',
  'slackbot',
  'slack-imgproxy',
  'telegrambot',
  'whatsapp',
  'mastodon',
  'pleroma',
  'akkoma',
  'bluesky',
  'bsky',
  'redditbot',
  'pinterest',
  'embedly',
  'iframely',
  'skypeuripreview',
  'applebot',
  'googlebot',
  'bingbot',
])

export const isCrawlerUserAgent = (ua: string | null | undefined): boolean => {
  if (!ua) return false
  const lower = ua.toLowerCase()
  return CRAWLER_UA_FRAGMENTS.some((frag) => lower.includes(frag))
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------
//
// Bare-minimum escaper for embedding user-supplied text in an HTML
// attribute or text node. Posts include free-form `title` and `note`
// fields written by whitelisters; treating them as trusted would be a
// stored-XSS footgun even though only meta-tag context is used. Cover
// the five canonical entities. We deliberately do NOT escape `/` —
// it's benign in attribute and text contexts, and escaping it makes
// URLs hard to read. The redirect URL is injected into a `<script>`
// via `JSON.stringify`, which handles the `</script>` breakout.
const escapeHtml = (input: string): string =>
  input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

// Description is shown as-is in social cards. Long bodies make the card
// look bad and some scrapers truncate at 200-300 chars anyway. Cap at
// 280 (X-style) and append an ellipsis on overflow.
const MAX_DESC_LEN = 280

const truncate = (input: string, max = MAX_DESC_LEN): string => {
  const trimmed = input.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// Markdown → plain text
// ---------------------------------------------------------------------------
//
// Twitter, Telegram, Slack, Discord, etc. render the og:description as
// raw text — Markdown syntax leaks through as backticks, asterisks, and
// `[text](url)` blobs that look broken. The post body is rendered as
// Markdown in the SPA, but here we want a clean plaintext slice.
//
// Deliberately a tiny inline pass instead of a full markdown parser:
// the description is at most ~280 chars and we only need to strip the
// most common syntax. Worst-case false negatives (uncommon constructs
// passing through) are cosmetic, not security-relevant.
const markdownToPlain = (s: string, maxLen = MAX_DESC_LEN): string => {
  const stripped = s
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks → space
    .replace(/`([^`]*)`/g, '$1') // inline code → contents
    .replace(/^\s{0,3}#+\s+/gm, '') // ATX headings → drop the leading hashes
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold → contents
    .replace(/(\*|_)(.*?)\1/g, '$2') // italic → contents
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → just the label
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // images → alt text (or nothing)
    .replace(/^\s{0,3}>\s?/gm, '') // blockquote markers
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen - 1)}…` : stripped
}

// ---------------------------------------------------------------------------
// Description builder
// ---------------------------------------------------------------------------
//
// "Onchain alert posted Apr 30, 2026 · 1 attacker · 2 victims · 5 confirmations"
const formatDate = (iso: string): string => {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  return new Date(ts).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

const pluralize = (n: number, singular: string): string =>
  `${n} ${singular}${n === 1 ? '' : 's'}`

const buildDescription = (post: RawPost): string => {
  const date = formatDate(post.createdAtTimestamp)
  const parts: string[] = []
  if (date) parts.push(`Onchain alert posted ${date}`)
  parts.push(pluralize(post.attackerLinks.length, 'attacker'))
  parts.push(pluralize(post.victimLinks.length, 'victim'))
  parts.push(pluralize(post.confirmations, 'confirmation'))
  if (post.disconfirmations > 0) {
    parts.push(pluralize(post.disconfirmations, 'disconfirmation'))
  }
  if (post.note?.trim()) {
    // Prepend the note body when there's room — gives the card real
    // signal beyond the boilerplate counters. The note is Markdown in
    // the SPA, but social-card scrapers render the description as raw
    // text, so we strip syntax (fences, inline code, headings,
    // bold/italic, link wrappers) here. Bound by markdownToPlain's own
    // maxLen so an enormous post can't blow past the description cap.
    const noteText = markdownToPlain(post.note)
    if (noteText) {
      return truncate(`${noteText} — ${parts.join(' · ')}`)
    }
  }
  return truncate(parts.join(' · '))
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Public site origin (no trailing slash). e.g. `https://thatsrekt.com`. */
  readonly siteOrigin: string
  /** Static fallback OG image path under siteOrigin. Per-post auto-generated images TBD. */
  readonly defaultImagePath: string
}

const DEFAULT_OPTIONS: RenderOptions = Object.freeze({
  siteOrigin: process.env.PUBLIC_SITE_ORIGIN ?? 'https://thatsrekt.com',
  defaultImagePath: '/og-image-default.png',
})

/**
 * Build the SPA's deep-link URL for a given chain + onchain post id.
 *
 * The frontend uses BrowserRouter and accepts `/post/:chain/:postId` as
 * a real pathname route. Browsers hitting Mesh's `/post/...` endpoint
 * are bounced here; Mesh's own canonical URL is also this path so
 * crawler-rendered cards link back to it.
 */
const spaUrl = (origin: string, chainSlug: string, onchainId: string): string =>
  `${origin}/post/${chainSlug}/${onchainId}`

interface RenderArgs {
  readonly title: string
  readonly description: string
  readonly canonicalUrl: string
  readonly imageUrl: string
  /** When set, emit a JS + meta-refresh redirect to this URL after meta tags. */
  readonly redirectTo?: string
  /** HTTP status to associate with this body. Used for 404. */
  readonly statusContext?: 'ok' | 'not-found'
}

const renderHtml = (args: RenderArgs): string => {
  const t = escapeHtml(args.title)
  const d = escapeHtml(args.description)
  const u = escapeHtml(args.canonicalUrl)
  const img = escapeHtml(args.imageUrl)
  const redirectMeta = args.redirectTo
    ? `\n    <meta http-equiv="refresh" content="0; url=${escapeHtml(args.redirectTo)}" />`
    : ''
  // Replace `<` with `<` inside the JSON-encoded URL so an attacker
  // can't break out of the `<script>` block via `</script>` even if the
  // upstream chainSlug somehow contained one (it can't — we only land
  // here for `[^/]+` segments — but this is the cheap belt-and-braces).
  const redirectScript = args.redirectTo
    ? `\n    <script>window.location.replace(${JSON.stringify(
        args.redirectTo,
      ).replace(/</g, '\\u003c')});</script>`
    : ''
  const statusComment =
    args.statusContext === 'not-found' ? '\n    <!-- post not found -->' : ''

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />${statusComment}
    <title>${t}</title>
    <meta name="description" content="${d}" />
    <link rel="canonical" href="${u}" />

    <meta property="og:type" content="article" />
    <meta property="og:title" content="${t}" />
    <meta property="og:description" content="${d}" />
    <meta property="og:url" content="${u}" />
    <meta property="og:site_name" content="thatsRekt" />
    <meta property="og:image" content="${img}" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${t}" />
    <meta name="twitter:description" content="${d}" />
    <meta name="twitter:image" content="${img}" />${redirectMeta}${redirectScript}
  </head>
  <body>
    <p>Loading <a href="${u}">${u}</a>…</p>
  </body>
</html>
`
}

// ---------------------------------------------------------------------------
// Upstream fetch — direct to per-chain squid (no Mesh prefix layer)
// ---------------------------------------------------------------------------

const fetchPostFromSquid = async (
  chain: ChainEntry,
  onchainId: string,
): Promise<RawPost | null> => {
  const res = await fetch(chain.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: POST_BY_ID_QUERY, variables: { id: onchainId } }),
  })
  if (!res.ok) {
    throw new Error(`Upstream ${chain.slug} returned ${res.status}`)
  }
  const json = (await res.json()) as { data?: unknown; errors?: unknown }
  if (json.errors) {
    // GraphQL errors at this layer mean the squid couldn't service the
    // query — treat as not-found rather than 500. The crawler still
    // gets a usable card.
    return null
  }
  const parsed = FetchPostByIdResponse.safeParse(json.data)
  if (!parsed.success) {
    console.error(
      `[mesh:og] ${chain.slug} postById response failed schema validation:`,
      parsed.error.flatten(),
    )
    return null
  }
  return parsed.data.postById
}

// ---------------------------------------------------------------------------
// Public entry point — used by the HTTP server in server.ts
// ---------------------------------------------------------------------------

export interface OgRouteResult {
  readonly status: number
  readonly html: string
}

export interface OgRouteDeps {
  readonly chains: readonly ChainEntry[]
  readonly options?: Partial<RenderOptions>
}

const matchOgPath = (
  pathname: string,
): { chainSlug: string; onchainId: string } | null => {
  // Match exactly `/post/<chain>/<id>` with no trailing path segments.
  // Allow trailing slash. Both `chain` and `id` are required.
  const m = /^\/post\/([^/]+)\/([^/]+)\/?$/.exec(pathname)
  if (!m) return null
  return { chainSlug: decodeURIComponent(m[1]!), onchainId: decodeURIComponent(m[2]!) }
}

export const isOgRoute = (pathname: string): boolean => matchOgPath(pathname) !== null

/**
 * Serve a `/post/:chain/:postId` request with OG-tagged HTML.
 *
 * Always emits the same dual-mode HTML — meta tags up top, JS+meta
 * redirect at the bottom — regardless of UA. The UA is only consulted
 * to decide whether to skip the redirect (so well-behaved crawlers can
 * scrape without tripping the redirect on JS-aware ones like Slackbot).
 */
export const handleOgRoute = async (
  pathname: string,
  userAgent: string | null,
  deps: OgRouteDeps,
): Promise<OgRouteResult | null> => {
  const match = matchOgPath(pathname)
  if (!match) return null

  const { chainSlug, onchainId } = match
  const opts: RenderOptions = { ...DEFAULT_OPTIONS, ...(deps.options ?? {}) }
  const isCrawler = isCrawlerUserAgent(userAgent)

  const chain = deps.chains.find((c) => c.slug === chainSlug)
  if (!chain) {
    return {
      status: 404,
      html: renderHtml({
        title: 'thatsRekt — unknown chain',
        description: `No chain with slug "${chainSlug}" is indexed by this gateway.`,
        canonicalUrl: opts.siteOrigin,
        imageUrl: `${opts.siteOrigin}${opts.defaultImagePath}`,
        redirectTo: isCrawler ? undefined : opts.siteOrigin,
        statusContext: 'not-found',
      }),
    }
  }

  // Validate onchainId shape — Subsquid post ids are decimal strings;
  // anything else is junk and shouldn't even hit the upstream.
  if (!/^\d+$/.test(onchainId)) {
    return {
      status: 404,
      html: renderHtml({
        title: 'thatsRekt — invalid post id',
        description: `"${onchainId}" is not a valid onchain post id.`,
        canonicalUrl: opts.siteOrigin,
        imageUrl: `${opts.siteOrigin}${opts.defaultImagePath}`,
        redirectTo: isCrawler ? undefined : opts.siteOrigin,
        statusContext: 'not-found',
      }),
    }
  }

  const canonicalUrl = spaUrl(opts.siteOrigin, chainSlug, onchainId)
  const imageUrl = `${opts.siteOrigin}${opts.defaultImagePath}`

  let post: RawPost | null = null
  try {
    post = await fetchPostFromSquid(chain, onchainId)
  } catch (err) {
    // Upstream unreachable — fall through to the generic card so the
    // card render itself isn't blocked on indexer health.
    console.error(`[mesh:og] failed to fetch ${chain.slug}/${onchainId}:`, err)
  }

  if (!post) {
    return {
      status: 404,
      html: renderHtml({
        title: 'thatsRekt — post not found',
        description: `No post with id ${onchainId} on ${chain.name}.`,
        canonicalUrl,
        imageUrl,
        redirectTo: isCrawler ? undefined : canonicalUrl,
        statusContext: 'not-found',
      }),
    }
  }

  const titleText = post.title?.trim() || `Onchain alert #${post.id}`
  const fullTitle = `thatsRekt — ${titleText}`
  const description = buildDescription(post)

  return {
    status: 200,
    html: renderHtml({
      title: fullTitle,
      description,
      canonicalUrl,
      imageUrl,
      // Skip the JS redirect for known crawlers — some are sticky about
      // not following redirects in card-fetch contexts. Browsers always
      // get redirected.
      redirectTo: isCrawler ? undefined : canonicalUrl,
    }),
  }
}

// Internal helper exports for tests / future reuse.
export const __internal = Object.freeze({
  matchOgPath,
  buildDescription,
  escapeHtml,
  truncate,
  markdownToPlain,
  CRAWLER_UA_FRAGMENTS,
})

// Type re-exports kept colocated so callers don't reach into chains.ts.
export type { ChainSlug }
