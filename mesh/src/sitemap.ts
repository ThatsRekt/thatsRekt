/**
 * Dynamic sitemap.xml generator for per-post URLs.
 *
 * Search engines (Google, Bing) consume sitemaps to discover URLs they
 * wouldn't otherwise crawl. The frontend's static `/sitemap.xml` only
 * lists the SPA shell routes (`/`, `/about`, `/posters`, `/docs`); the
 * per-post pages (`/post/:chain/:postId`) are dynamic and need to be
 * enumerated server-side from indexer data.
 *
 * Mesh exposes `/sitemap-attacks.xml` — fans out to every per-chain squid,
 * pulls every non-purged post (id + lastUpdatedAt), and emits a flat
 * urlset. We deliberately omit purged posts: the URL still works (it
 * renders a tombstone), but there's no value in feeding search engines
 * URLs whose content has been governance-removed.
 *
 * Scale: a single urlset file can hold up to 50,000 URLs / 50 MiB
 * uncompressed. We stay well under both limits today; switch to a
 * sitemap-index when we cross ~10k posts.
 */
import { z } from 'zod'

import type { ChainEntry } from './chains.js'

const SitemapPost = z.object({
  id: z.string(),
  lastUpdatedAt: z.string().optional(),
  createdAtTimestamp: z.string(),
})
type SitemapPost = z.infer<typeof SitemapPost>

const FetchSitemapPostsResponse = z.object({
  posts: z.array(SitemapPost),
})

// Pull only the fields needed to emit `<loc>` and `<lastmod>`.
// `where: { purged_eq: false }` filters tombstoned posts upstream so we
// don't pull rows we'd just skip locally.
//
// Limit is generous: today every chain has fewer than 1000 posts; if a
// chain ever crosses this limit we'll start losing URLs from the sitemap
// and need to paginate. The limit chosen here (5000) gives ~5x headroom
// per chain while staying under Subsquid's 10k default.
const FETCH_POSTS_QUERY = /* GraphQL */ `
  query SitemapPosts {
    posts(orderBy: createdAtBlock_DESC, limit: 5000, where: { purged_eq: false }) {
      id
      lastUpdatedAt
      createdAtTimestamp
    }
  }
`

const fetchPostsForChain = async (chain: ChainEntry): Promise<readonly SitemapPost[]> => {
  const res = await fetch(chain.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: FETCH_POSTS_QUERY }),
  })
  if (!res.ok) {
    throw new Error(`Upstream ${chain.slug} returned ${res.status}`)
  }
  const json = (await res.json()) as { data?: unknown; errors?: unknown }
  if (json.errors) {
    console.error(`[mesh:sitemap] ${chain.slug} returned errors:`, json.errors)
    return []
  }
  const parsed = FetchSitemapPostsResponse.safeParse(json.data)
  if (!parsed.success) {
    console.error(
      `[mesh:sitemap] ${chain.slug} response failed schema validation:`,
      parsed.error.flatten(),
    )
    return []
  }
  return parsed.data.posts
}

// XML doesn't need much escaping for the values we emit (URLs are ASCII,
// timestamps are ISO 8601), but `<loc>` accepts arbitrary URLs and we
// build them from chain slugs that we control. Defensive escape anyway —
// cheap and stops a future "weird chain slug" surprise from generating
// invalid XML.
const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

// Coerce a timestamp into the W3C-datetime format Google's sitemap
// validator likes (`YYYY-MM-DDThh:mm:ss[+-]hh:mm` or `…Z`). Subsquid
// emits ISO 8601 strings already; just round-trip through Date to
// drop any sub-second precision a search engine might trip over.
const isoLastmod = (iso: string): string => {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  return new Date(ts).toISOString()
}

interface SitemapEntry {
  readonly loc: string
  readonly lastmod: string
}

const renderUrlset = (entries: readonly SitemapEntry[]): string => {
  const urls = entries
    .map(
      (e) => `  <url>
    <loc>${escapeXml(e.loc)}</loc>
    <lastmod>${escapeXml(e.lastmod)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`
}

export interface SitemapDeps {
  readonly chains: readonly ChainEntry[]
  readonly siteOrigin?: string
}

const DEFAULT_ORIGIN = process.env.PUBLIC_SITE_ORIGIN ?? 'https://thatsrekt.com'

export interface SitemapResult {
  readonly status: number
  readonly body: string
  readonly contentType: string
}

const SITEMAP_PATH = '/sitemap-attacks.xml'

export const isSitemapAttacksRoute = (pathname: string): boolean =>
  pathname === SITEMAP_PATH || pathname === `${SITEMAP_PATH}/`

/**
 * Build the per-post sitemap by fanning out to every enabled chain's
 * squid GraphQL endpoint. Failures on individual chains are logged and
 * the surviving entries are still emitted; a single dead upstream
 * shouldn't 500 the sitemap.
 */
export const handleSitemapAttacksRoute = async (
  pathname: string,
  deps: SitemapDeps,
): Promise<SitemapResult | null> => {
  if (!isSitemapAttacksRoute(pathname)) return null

  const origin = deps.siteOrigin ?? DEFAULT_ORIGIN
  const results = await Promise.allSettled(
    deps.chains.map(async (chain) => ({ chain, posts: await fetchPostsForChain(chain) })),
  )

  const entries: SitemapEntry[] = []
  for (const r of results) {
    if (r.status !== 'fulfilled') {
      console.error('[mesh:sitemap] chain fetch failed:', r.reason)
      continue
    }
    const { chain, posts } = r.value
    for (const p of posts) {
      const lastmod = isoLastmod(p.lastUpdatedAt ?? p.createdAtTimestamp)
      if (!lastmod) continue
      entries.push({
        loc: `${origin}/post/${chain.slug}/${p.id}`,
        lastmod,
      })
    }
  }

  // Sort newest-first so the most recently updated posts get crawled
  // first when a search engine processes the sitemap top-down.
  entries.sort((a, b) => (a.lastmod < b.lastmod ? 1 : a.lastmod > b.lastmod ? -1 : 0))

  return {
    status: 200,
    contentType: 'application/xml; charset=utf-8',
    body: renderUrlset(entries),
  }
}

// Internal helpers for tests / future reuse.
export const __internal = Object.freeze({
  escapeXml,
  isoLastmod,
  renderUrlset,
})
