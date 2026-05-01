import { useEffect, useState } from 'react'

/**
 * Copy-to-clipboard share button. Resolves the post path to an absolute
 * URL using the current `window.location.origin`, so:
 *
 *   - on production: `https://thatsrekt.com/post/base/42`
 *   - on local dev:  `http://localhost:5175/post/base/42`
 *
 * Pasting that URL into Telegram / X / Discord triggers the OG card our
 * Mesh server-renders at `/post/:chain/:postId` — i.e. the user gets
 * the rich preview "for free" once the link is shared.
 *
 * Two stages, single button:
 *   1. idle  → `[ share ]`
 *   2. just-copied → `[ copied ]` for 1.6s, then back to idle
 *
 * The visual delta is intentional but minimal — same border/padding,
 * the label flips and the bg tints emerald briefly so you see the
 * action landed without a toast or modal. Brutalist, consistent.
 *
 * Implementation note: `navigator.clipboard.writeText` requires a
 * secure context (HTTPS or localhost) and a transient user-gesture.
 * Click handlers count as a gesture; serving over HTTPS in prod means
 * the API is available. On insecure pages (rare here) the catch path
 * surfaces a fallback.
 */
export function ShareButton({
  path,
  label = 'share',
  size = 'sm',
}: {
  /** Site-relative path, e.g. `/post/base/42`. */
  path: string
  /** Override the idle label. Defaults to `share`. */
  label?: string
  /** `sm` for feed cards, `md` for the post detail page. */
  size?: 'sm' | 'md'
}) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])

  const handleClick = async (e: React.MouseEvent) => {
    // Stop the parent <Link> (when this is rendered inside a card-wide
    // anchor) from navigating on the same click.
    e.preventDefault()
    e.stopPropagation()

    const origin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : ''
    const url = `${origin}${path}`

    try {
      if (!navigator.clipboard) throw new Error('clipboard api unavailable')
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setError(null)
    } catch (err) {
      // Insecure context / older browser fallback — drop the URL into
      // a hidden textarea + execCommand. Last-ditch; modern Chrome /
      // Safari / Firefox in HTTPS won't hit this.
      try {
        const ta = document.createElement('textarea')
        ta.value = url
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        setCopied(true)
        setError(null)
      } catch {
        setError('copy failed')
      }
    }
  }

  const padding =
    size === 'md' ? 'px-3 py-2 text-xs' : 'px-2 py-1 text-[11px]'
  const tone = copied
    ? 'border-emerald-700 bg-emerald-50 text-emerald-800'
    : error
      ? 'border-red-700 bg-red-50 text-red-700'
      : 'border-black bg-white text-neutral-800 hover:bg-yellow-100'
  const display = copied ? 'copied' : error ? 'copy failed' : label

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={`copy share url for this post`}
      className={
        'inline-flex items-center gap-1 whitespace-nowrap border-2 uppercase tracking-widest font-black transition-colors ' +
        padding +
        ' ' +
        tone
      }
    >
      [{display}]
    </button>
  )
}
