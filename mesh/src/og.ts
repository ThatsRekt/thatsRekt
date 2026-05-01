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
 * Two HTTP routes are served from this module:
 *
 *   GET /post/:chain/:postId
 *     → SSR'd HTML with og:* + twitter:* meta tags + Article JSON-LD,
 *       backed by a JS+meta-refresh redirect to the SPA route. The
 *       og:image points at the route below.
 *
 *   GET /og/post/:chain/:postId
 *     → 1200x630 SVG card rendered from on-chain post data. Brutalist
 *       cream/black/red palette. Telegram, X, and Discord all render
 *       SVG OG images; if one client breaks we can swap to PNG via a
 *       headless renderer without changing the URL.
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
  // lastUpdatedAt is optional on the wire so an upstream squid that
  // hasn't applied the recent migration won't blow up the OG renderer.
  // Falls back to createdAtTimestamp at the use site.
  lastUpdatedAt: z.string().optional(),
  confirmations: z.number().int(),
  disconfirmations: z.number().int(),
  netScore: z.number().int(),
  removed: z.boolean(),
  // Optional on the wire so an upstream squid that hasn't applied the
  // purge migration yet doesn't blow up the OG renderer. Coalesced to
  // `false` at the use site.
  purged: z.boolean().optional(),
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
      lastUpdatedAt
      confirmations
      disconfirmations
      netScore
      removed
      purged
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

// SVG character data is a strict subset of XML — same five entities matter
// here too. Re-using escapeHtml for SVG text nodes is correct because both
// HTML and XML treat `&`, `<`, `>`, `"`, `'` the same for entity escaping.
const escapeXml = escapeHtml

// JSON-LD lives inside a <script type="application/ld+json"> block. The
// JSON parser tolerates Unicode but the surrounding HTML parser will end
// the script on a literal `</script>`. JSON.stringify already escapes
// double-quotes; we additionally escape `<` to `<` so an attacker-
// controlled title containing `</script>` can't break out of the block.
const safeJsonLd = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c')

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
// Address truncation + relative time
// ---------------------------------------------------------------------------
//
// `0xda1bdef0…7f45` style. Hex strings only — caller is expected to pass
// a 0x-prefixed lowercased address; we don't validate, since the upstream
// already does. If junk slips through we just render junk truncated, no
// security concern.
const truncateAddress = (addr: string, lead = 6, tail = 4): string => {
  if (addr.length <= lead + tail + 2) return addr
  return `${addr.slice(0, lead + 2)}…${addr.slice(-tail)}`
}

// "3h ago", "2d ago", "just now" — coarse buckets, no fancy library.
// Hosts a tiny bit of polish on the OG card without pulling in date-fns.
// Returns the empty string for unparseable / future timestamps; caller
// should treat empty as "skip this line".
const relativeTime = (iso: string, now: number = Date.now()): string => {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const deltaSec = Math.floor((now - ts) / 1000)
  if (deltaSec < 0) return ''
  if (deltaSec < 60) return 'just now'
  const m = Math.floor(deltaSec / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  const y = Math.floor(d / 365)
  return `${y}y ago`
}

// ---------------------------------------------------------------------------
// Etherscan-style explorer URL for a chain (used inside Article JSON-LD).
// ---------------------------------------------------------------------------
//
// Best-effort: a small lookup table keyed by the slugs we actually serve.
// Unknown chain → empty string, and the JSON-LD just omits the author
// `url` field. We don't want a hard dependency on a chain registry here.
const explorerAddressUrl = (chainSlug: string, address: string): string => {
  const base: Record<string, string> = {
    'anvil-eth': '',
    'anvil-base': '',
    'sepolia': 'https://sepolia.etherscan.io',
    'base': 'https://basescan.org',
    'base-sepolia': 'https://sepolia.basescan.org',
    'optimism': 'https://optimistic.etherscan.io',
  }
  const root = base[chainSlug]
  if (!root) return ''
  return `${root}/address/${address}`
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Public site origin (no trailing slash). e.g. `https://thatsrekt.com`. */
  readonly siteOrigin: string
  /** Static fallback OG image path under siteOrigin. Used when the dynamic SVG card can't be built (e.g. unknown chain, invalid id). */
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

/**
 * URL of the per-post SVG OG image served by `/og/post/:chain/:postId`.
 *
 * Kept as an absolute URL because social-media crawlers will fetch it
 * directly; relative URLs in og:image break for some clients.
 */
const ogImageUrl = (origin: string, chainSlug: string, onchainId: string): string =>
  `${origin}/og/post/${chainSlug}/${onchainId}`

interface RenderArgs {
  readonly title: string
  readonly description: string
  readonly canonicalUrl: string
  readonly imageUrl: string
  /** Optional Article JSON-LD block — embedded raw inside <script type="application/ld+json">. */
  readonly jsonLd?: string
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
  // Article JSON-LD goes in the <head> so crawlers pick it up before
  // any redirect runs. The body comes pre-escaped (`safeJsonLd` already
  // handled the `</script>` breakout); embedding raw is correct.
  const jsonLdBlock = args.jsonLd
    ? `\n    <script type="application/ld+json">${args.jsonLd}</script>`
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
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${t}" />
    <meta name="twitter:description" content="${d}" />
    <meta name="twitter:image" content="${img}" />${jsonLdBlock}${redirectMeta}${redirectScript}
  </head>
  <body>
    <p>Loading <a href="${u}">${u}</a>…</p>
  </body>
</html>
`
}

// ---------------------------------------------------------------------------
// SVG OG card renderer
// ---------------------------------------------------------------------------
//
// 1200x630 brutalist card. Cream background, black border, red accents.
// Pure SVG — no external image references — so social-card scrapers can
// rasterize it without a side fetch. Fits comfortably under 8KB.
//
// Layout (top to bottom):
//   • [ ALERT ] chip (top-right, red) + [ thatsrekt.com ] text (top-left)
//   • headline title (large, font-black, wrapped)
//   • byline `posted by 0xabcd…1234` + `attacked Xh ago`
//   • stat strip: `[ N ATTACKERS · M VICTIMS ]`
//   • bottom: chain name + post id

const SVG_W = 1200
const SVG_H = 630

const COLORS = Object.freeze({
  cream: '#f5f4ee',
  black: '#000000',
  red: '#dc2626',
  neutral: '#404040',
})

// Naive word wrap — split on whitespace, accumulate up to maxChars per
// line, hard-break overlong words. SVG <text> doesn't wrap natively; we
// emit one <tspan dy=...> per line. `maxChars` is tuned for the chosen
// font-size + font-family to fit within the card's content rect; if it
// overshoots a line gets clipped by the card border, which is loud and
// obvious during local testing.
const wrapLines = (text: string, maxChars: number, maxLines: number): readonly string[] => {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    // Hard-break a single word longer than maxChars (shouldn't happen
    // with normal titles but is cheap to guard against).
    if (word.length > maxChars) {
      if (current) {
        lines.push(current)
        current = ''
      }
      for (let i = 0; i < word.length; i += maxChars) {
        const chunk = word.slice(i, i + maxChars)
        if (lines.length >= maxLines) return lines
        if (i + maxChars >= word.length) {
          current = chunk
        } else {
          lines.push(chunk)
        }
      }
      continue
    }
    const trial = current ? `${current} ${word}` : word
    if (trial.length <= maxChars) {
      current = trial
    } else {
      lines.push(current)
      current = word
      if (lines.length >= maxLines) break
    }
  }
  if (current && lines.length < maxLines) lines.push(current)
  if (lines.length > maxLines) {
    const truncated = lines.slice(0, maxLines)
    const last = truncated[maxLines - 1]
    if (last && last.length > maxChars - 1) {
      truncated[maxLines - 1] = `${last.slice(0, maxChars - 1)}…`
    } else if (last) {
      truncated[maxLines - 1] = `${last}…`
    }
    return truncated
  }
  return lines
}

// Card variants emit slightly different bodies. Common border + chrome
// lives in `renderCardChrome`; the variant renderer fills in the middle.
const renderCardChrome = (body: string, options: { tomb?: boolean } = {}): string => {
  const bg = options.tomb ? COLORS.cream : COLORS.cream
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_W} ${SVG_H}" width="${SVG_W}" height="${SVG_H}" role="img" aria-label="thatsRekt onchain alert">
  <rect x="0" y="0" width="${SVG_W}" height="${SVG_H}" fill="${bg}" />
  <rect x="4" y="4" width="${SVG_W - 8}" height="${SVG_H - 8}" fill="none" stroke="${COLORS.black}" stroke-width="8" />

  <!-- top-left wordmark -->
  <text x="48" y="78" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="28" font-weight="700" fill="${COLORS.black}" letter-spacing="2">thats<tspan fill="${COLORS.red}">rekt</tspan>.com</text>

  <!-- top-right [ ALERT ] chip -->
  <g transform="translate(${SVG_W - 220}, 36)">
    <rect x="0" y="0" width="172" height="56" fill="${COLORS.red}" />
    <text x="86" y="38" text-anchor="middle" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="26" font-weight="900" fill="${COLORS.cream}" letter-spacing="4">[ ALERT ]</text>
  </g>

${body}

  <!-- bottom rule -->
  <line x1="48" y1="${SVG_H - 70}" x2="${SVG_W - 48}" y2="${SVG_H - 70}" stroke="${COLORS.black}" stroke-width="3" />
</svg>`
}

interface CardCounts {
  readonly attackers: number
  readonly victims: number
  readonly confirmations: number
}

interface CardData {
  readonly title: string
  readonly poster: string
  readonly attackedRelative: string
  readonly counts: CardCounts
  readonly chainName: string
  readonly onchainId: string
}

const renderLiveCardBody = (data: CardData): string => {
  // Wrap width tuned for the title font: monospace at ~64pt averages
  // ~0.6em per char, so 28 chars per line fills ~1075px (just under
  // the 1104px content rect). Three lines max — anything longer gets
  // ellipsis-truncated by wrapLines.
  const titleLines = wrapLines(data.title || `Onchain alert #${data.onchainId}`, 28, 3)
  // Title rendered as <tspan dy="1.05em"> blocks. y= is the baseline
  // of the FIRST line; subsequent tspans shift down by 1.05 em.
  const titleY = 200
  const titleSize = 64
  const titleTspans = titleLines
    .map((line, i) =>
      i === 0
        ? `<tspan x="48" dy="0">${escapeXml(line)}</tspan>`
        : `<tspan x="48" dy="1.05em">${escapeXml(line)}</tspan>`,
    )
    .join('')
  const truncatedPoster = truncateAddress(data.poster)
  const byline = `posted by ${truncatedPoster}`
  const timeline = data.attackedRelative ? `attacked ${data.attackedRelative}` : ''

  // Stat chip: [ N ATTACKERS · M VICTIMS ]. Width grows with content;
  // we just left-anchor and let the chip render as long as the text needs.
  const statText = `[ ${data.counts.attackers} ATTACKER${data.counts.attackers === 1 ? '' : 'S'}  ·  ${data.counts.victims} VICTIM${data.counts.victims === 1 ? '' : 'S'} ]`
  const chainBadge = `${data.chainName} · post #${data.onchainId}`

  return `  <!-- title -->
  <text x="48" y="${titleY}" font-family="ui-monospace, Menlo, Consolas, 'Courier New', monospace" font-size="${titleSize}" font-weight="900" fill="${COLORS.black}">${titleTspans}</text>

  <!-- byline + timeline -->
  <text x="48" y="${SVG_H - 200}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="26" font-weight="500" fill="${COLORS.neutral}">${escapeXml(byline)}</text>
  <text x="48" y="${SVG_H - 162}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="22" font-weight="500" fill="${COLORS.neutral}">${escapeXml(timeline)}</text>

  <!-- attacker / victim counts -->
  <g transform="translate(48, ${SVG_H - 130})">
    <rect x="0" y="0" width="${SVG_W - 96}" height="50" fill="${COLORS.black}" />
    <text x="20" y="34" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="24" font-weight="900" fill="${COLORS.cream}" letter-spacing="2">${escapeXml(statText)}</text>
  </g>

  <!-- chain badge bottom-right -->
  <text x="${SVG_W - 48}" y="${SVG_H - 32}" text-anchor="end" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="20" font-weight="500" fill="${COLORS.neutral}">${escapeXml(chainBadge)}</text>

  <!-- bottom-left brand chip -->
  <text x="48" y="${SVG_H - 32}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="20" font-weight="700" fill="${COLORS.black}" letter-spacing="2">on-chain hack alerts.</text>
`
}

const renderTombstoneCardBody = (chainName: string, onchainId: string): string => {
  const chainBadge = `${chainName} · post #${onchainId}`
  return `  <!-- tombstone heading -->
  <text x="48" y="220" font-family="ui-monospace, Menlo, Consolas, 'Courier New', monospace" font-size="72" font-weight="900" fill="${COLORS.black}"><tspan x="48" dy="0">[ PURGED ]</tspan><tspan x="48" dy="1.1em">BY GOVERNANCE</tspan></text>

  <!-- subhead -->
  <text x="48" y="${SVG_H - 200}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="24" font-weight="500" fill="${COLORS.neutral}">This alert was removed from the registry.</text>
  <text x="48" y="${SVG_H - 162}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="22" font-weight="500" fill="${COLORS.neutral}">The on-chain post id remains; its content does not.</text>

  <!-- chain badge bottom-right -->
  <text x="${SVG_W - 48}" y="${SVG_H - 32}" text-anchor="end" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="20" font-weight="500" fill="${COLORS.neutral}">${escapeXml(chainBadge)}</text>

  <!-- bottom-left brand chip -->
  <text x="48" y="${SVG_H - 32}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="20" font-weight="700" fill="${COLORS.black}" letter-spacing="2">on-chain hack alerts.</text>
`
}

const renderGenericCardBody = (heading: string, sub: string): string =>
  `  <text x="48" y="220" font-family="ui-monospace, Menlo, Consolas, 'Courier New', monospace" font-size="80" font-weight="900" fill="${COLORS.black}"><tspan x="48" dy="0">${escapeXml(heading)}</tspan></text>
  <text x="48" y="${SVG_H - 200}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="24" font-weight="500" fill="${COLORS.neutral}">${escapeXml(sub)}</text>
  <text x="48" y="${SVG_H - 32}" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="20" font-weight="700" fill="${COLORS.black}" letter-spacing="2">on-chain hack alerts.</text>
`

/**
 * Render a 1200x630 SVG card for a live (non-purged) post.
 *
 * Pure function of the post + chain — same input always produces the
 * same SVG bytes (modulo the relative-time string, which depends on
 * `now`). Caller-controlled `now` enables deterministic rendering in
 * tests.
 */
export const renderOgImageSvg = (
  post: RawPost,
  chain: ChainEntry,
  now: number = Date.now(),
): string => {
  if (post.purged === true) {
    return renderCardChrome(renderTombstoneCardBody(chain.name, post.id), { tomb: true })
  }
  const data: CardData = {
    title: post.title?.trim() || `Onchain alert #${post.id}`,
    poster: post.poster.id,
    attackedRelative: relativeTime(post.attackedAt, now),
    counts: {
      attackers: post.attackerLinks.length,
      victims: post.victimLinks.length,
      confirmations: post.confirmations,
    },
    chainName: chain.name,
    onchainId: post.id,
  }
  return renderCardChrome(renderLiveCardBody(data))
}

const renderTombstoneSvg = (chainName: string, onchainId: string): string =>
  renderCardChrome(renderTombstoneCardBody(chainName, onchainId), { tomb: true })

const renderGenericFallbackSvg = (heading: string, sub: string): string =>
  renderCardChrome(renderGenericCardBody(heading, sub))

// ---------------------------------------------------------------------------
// Article JSON-LD builder
// ---------------------------------------------------------------------------
//
// Schema.org NewsArticle. Search engines consume this for rich-result
// eligibility (Google "Top stories" etc.). For purged posts we emit a
// tombstone Article: the URL stays indexable, but the original headline
// and body are deliberately omitted.

const buildArticleJsonLd = (args: {
  readonly post: RawPost
  readonly chain: ChainEntry
  readonly canonicalUrl: string
  readonly imageUrl: string
  readonly siteOrigin: string
}): string => {
  const { post, chain, canonicalUrl, imageUrl, siteOrigin } = args
  const datePublished = post.createdAtTimestamp
  const dateModified = post.lastUpdatedAt ?? post.createdAtTimestamp

  if (post.purged === true) {
    // Deliberate: no headline, no description, no author. The URL still
    // identifies a real (now-empty) post; crawlers can index it and
    // searchers landing on the page see the tombstone.
    return safeJsonLd({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: 'Purged by governance',
      datePublished,
      dateModified,
      url: canonicalUrl,
      image: imageUrl,
      publisher: {
        '@type': 'Organization',
        name: 'thatsRekt',
        url: `${siteOrigin}/`,
      },
    })
  }

  const headline = post.title?.trim() || `Onchain alert #${post.id}`
  const authorAddr = post.poster.id
  const authorUrl = explorerAddressUrl(chain.slug, authorAddr)
  const author: Record<string, string> = {
    '@type': 'Person',
    name: truncateAddress(authorAddr),
  }
  if (authorUrl) author.url = authorUrl

  return safeJsonLd({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline,
    datePublished,
    dateModified,
    author,
    publisher: {
      '@type': 'Organization',
      name: 'thatsRekt',
      url: `${siteOrigin}/`,
    },
    image: imageUrl,
    url: canonicalUrl,
  })
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
  /** Response body. */
  readonly body: string
  /** Mime type for the response body. Drives the Content-Type header. */
  readonly contentType: string
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

const matchOgImagePath = (
  pathname: string,
): { chainSlug: string; onchainId: string } | null => {
  // Match exactly `/og/post/<chain>/<id>`.
  const m = /^\/og\/post\/([^/]+)\/([^/]+)\/?$/.exec(pathname)
  if (!m) return null
  return { chainSlug: decodeURIComponent(m[1]!), onchainId: decodeURIComponent(m[2]!) }
}

export const isOgRoute = (pathname: string): boolean => matchOgPath(pathname) !== null
export const isOgImageRoute = (pathname: string): boolean =>
  matchOgImagePath(pathname) !== null

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
  const fallbackImage = `${opts.siteOrigin}${opts.defaultImagePath}`

  const chain = deps.chains.find((c) => c.slug === chainSlug)
  if (!chain) {
    return {
      status: 404,
      contentType: 'text/html; charset=utf-8',
      body: renderHtml({
        title: 'thatsRekt — unknown chain',
        description: `No chain with slug "${chainSlug}" is indexed by this gateway.`,
        canonicalUrl: opts.siteOrigin,
        imageUrl: fallbackImage,
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
      contentType: 'text/html; charset=utf-8',
      body: renderHtml({
        title: 'thatsRekt — invalid post id',
        description: `"${onchainId}" is not a valid onchain post id.`,
        canonicalUrl: opts.siteOrigin,
        imageUrl: fallbackImage,
        redirectTo: isCrawler ? undefined : opts.siteOrigin,
        statusContext: 'not-found',
      }),
    }
  }

  const canonicalUrl = spaUrl(opts.siteOrigin, chainSlug, onchainId)
  const dynamicImage = ogImageUrl(opts.siteOrigin, chainSlug, onchainId)

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
      contentType: 'text/html; charset=utf-8',
      body: renderHtml({
        title: 'thatsRekt — post not found',
        description: `No post with id ${onchainId} on ${chain.name}.`,
        canonicalUrl,
        imageUrl: fallbackImage,
        redirectTo: isCrawler ? undefined : canonicalUrl,
        statusContext: 'not-found',
      }),
    }
  }

  // Purged posts get a neutral tombstone card. We deliberately do NOT
  // surface the original title / note in any meta tag — the entire
  // point of governance purging is that the offending content stays
  // out of social cards even though it's still readable on-chain.
  if (post.purged === true) {
    const jsonLd = buildArticleJsonLd({
      post,
      chain,
      canonicalUrl,
      imageUrl: dynamicImage,
      siteOrigin: opts.siteOrigin,
    })
    return {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: renderHtml({
        title: 'thatsRekt — purged',
        description: 'This attack was purged from the registry by governance.',
        canonicalUrl,
        imageUrl: dynamicImage,
        jsonLd,
        redirectTo: isCrawler ? undefined : canonicalUrl,
      }),
    }
  }

  const titleText = post.title?.trim() || `Onchain alert #${post.id}`
  const fullTitle = `thatsRekt — ${titleText}`
  const description = buildDescription(post)
  const jsonLd = buildArticleJsonLd({
    post,
    chain,
    canonicalUrl,
    imageUrl: dynamicImage,
    siteOrigin: opts.siteOrigin,
  })

  return {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: renderHtml({
      title: fullTitle,
      description,
      canonicalUrl,
      imageUrl: dynamicImage,
      jsonLd,
      // Skip the JS redirect for known crawlers — some are sticky about
      // not following redirects in card-fetch contexts. Browsers always
      // get redirected.
      redirectTo: isCrawler ? undefined : canonicalUrl,
    }),
  }
}

/**
 * Serve a `/og/post/:chain/:postId` request with the SVG OG card.
 *
 * Returns image/svg+xml. Cached short-term (Cache-Control set in the
 * server) since post counts mutate on every confirmation/disconfirmation
 * vote. If a chain or post id is bad, we still return a valid SVG with
 * a "not found" tombstone — social-card scrapers tend to silently drop
 * the og:image if the URL 404s, so always returning a card preserves
 * preview behavior.
 */
export const handleOgImageRoute = async (
  pathname: string,
  deps: OgRouteDeps,
): Promise<OgRouteResult | null> => {
  const match = matchOgImagePath(pathname)
  if (!match) return null

  const { chainSlug, onchainId } = match
  const chain = deps.chains.find((c) => c.slug === chainSlug)
  if (!chain) {
    return {
      status: 404,
      contentType: 'image/svg+xml; charset=utf-8',
      body: renderGenericFallbackSvg(`[ UNKNOWN CHAIN ]`, `No chain "${chainSlug}".`),
    }
  }

  if (!/^\d+$/.test(onchainId)) {
    return {
      status: 404,
      contentType: 'image/svg+xml; charset=utf-8',
      body: renderGenericFallbackSvg(`[ INVALID ID ]`, `"${onchainId}" is not a valid post id.`),
    }
  }

  let post: RawPost | null = null
  try {
    post = await fetchPostFromSquid(chain, onchainId)
  } catch (err) {
    console.error(`[mesh:og:image] failed to fetch ${chain.slug}/${onchainId}:`, err)
  }

  if (!post) {
    return {
      status: 404,
      contentType: 'image/svg+xml; charset=utf-8',
      body: renderGenericFallbackSvg(`[ NOT FOUND ]`, `No post #${onchainId} on ${chain.name}.`),
    }
  }

  if (post.purged === true) {
    return {
      status: 200,
      contentType: 'image/svg+xml; charset=utf-8',
      body: renderTombstoneSvg(chain.name, post.id),
    }
  }

  return {
    status: 200,
    contentType: 'image/svg+xml; charset=utf-8',
    body: renderOgImageSvg(post, chain),
  }
}

// Internal helper exports for tests / future reuse.
export const __internal = Object.freeze({
  matchOgPath,
  matchOgImagePath,
  buildDescription,
  buildArticleJsonLd,
  escapeHtml,
  truncate,
  truncateAddress,
  relativeTime,
  markdownToPlain,
  wrapLines,
  renderTombstoneSvg,
  CRAWLER_UA_FRAGMENTS,
})

// Type re-exports kept colocated so callers don't reach into chains.ts.
export type { ChainSlug }
