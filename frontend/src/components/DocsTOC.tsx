import { useEffect, useState } from 'react'

/**
 * Sticky left-side table of contents for /docs.
 *
 * Desktop only — hidden on tablet/mobile (the page is short enough that
 * a hamburger TOC isn't worth the complexity). Highlights the section
 * currently in view via IntersectionObserver, click-scrolls smoothly
 * to anchor targets, and auto-collapses when below the page footer.
 *
 * The `entries` array drives both render and the active-section
 * observer; section ids must match what `Section heading="..."`
 * generates (see `slugify`).
 */
export function DocsTOC({ entries }: { entries: ReadonlyArray<TocEntry> }) {
  const [activeId, setActiveId] = useState<string | null>(entries[0]?.id ?? null)

  useEffect(() => {
    if (typeof window === 'undefined') return

    // Top-of-viewport bias: a section is "active" once it crosses the
    // top quarter of the viewport. Without this, sections appear to
    // toggle a beat too late as you scroll down.
    const observer = new IntersectionObserver(
      (records) => {
        const visible = records
          .filter((r) => r.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]?.target.id) {
          setActiveId(visible[0].target.id)
        }
      },
      { rootMargin: '-15% 0px -70% 0px', threshold: 0 },
    )

    for (const e of entries) {
      const el = document.getElementById(e.id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [entries])

  return (
    <nav
      aria-label="docs sections"
      className="hidden lg:block lg:w-44 lg:shrink-0"
    >
      <div className="sticky top-6 space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-neutral-500 pb-2 border-b-2 border-black">
          [contents]
        </p>
        <ul className="space-y-1.5 text-xs">
          {entries.map((e) => {
            const active = activeId === e.id
            return (
              <li key={e.id}>
                <a
                  href={`#${e.id}`}
                  onClick={(ev) => onAnchorClick(ev, e.id, setActiveId)}
                  className={[
                    'block leading-snug uppercase tracking-widest font-bold',
                    'border-l-2 pl-2 py-0.5',
                    'transition-colors',
                    active
                      ? 'border-black text-black'
                      : 'border-neutral-300 text-neutral-500 hover:text-black hover:border-neutral-700',
                  ].join(' ')}
                >
                  {e.label}
                </a>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}

/**
 * Click handler — prevents the default jump and uses smooth scroll, also
 * eagerly sets the active id so the highlight doesn't lag behind the
 * IntersectionObserver during the scroll animation.
 */
function onAnchorClick(
  ev: React.MouseEvent<HTMLAnchorElement>,
  id: string,
  setActiveId: (id: string) => void,
) {
  const el = document.getElementById(id)
  if (!el) return // fall through to default browser jump
  ev.preventDefault()
  setActiveId(id)
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // Update the URL hash without triggering another scroll
  if (window.history.replaceState) {
    window.history.replaceState(null, '', `#${id}`)
  }
}

export type TocEntry = {
  id: string
  label: string
}

/**
 * Slug helper — kept exported so Section consumers can derive the same
 * id from heading text without hard-coding strings in two places.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
