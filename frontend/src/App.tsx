import { useEffect, useRef, useState } from 'react'
import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom'
import { Feed } from './pages/Feed'
import { PostDetail } from './pages/PostDetail'
import { About } from './pages/About'
import { Posters } from './pages/Posters'
import { Leaderboard } from './pages/Leaderboard'
import { Docs } from './pages/Docs'
import { IS_MOCK_MODE } from './lib/queries'
import { useHasPosts } from './hooks/useHasPosts'
import { PostAlertButton, AccountChip } from './components/PostAlertButton'

const NAV_LINKS: { to: string; label: string }[] = [
  { to: '/', label: 'feed' },
  { to: '/about', label: 'about' },
  { to: '/posters', label: 'posters' },
  { to: '/leaderboard', label: 'leaderboard' },
  { to: '/docs', label: 'docs' },
]

/** Routes that should disappear from nav + redirect to `/` when no posts exist. */
const POST_GATED_ROUTES = new Set(['/leaderboard'])

export function App() {
  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col px-6 py-10">
      {IS_MOCK_MODE && <MockBanner />}
      <Header />
      <main className="flex-1 pt-10">
        <Routes>
          <Route path="/" element={<Feed />} />
          <Route path="/post/:id" element={<PostDetail />} />
          <Route path="/about" element={<About />} />
          <Route path="/posters" element={<Posters />} />
          <Route path="/leaderboard" element={<LeaderboardGate />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}

/**
 * Gate the `/leaderboard` route on post existence. While we're still
 * checking, render a brutalist "checking…" placeholder rather than
 * flashing the full Leaderboard or bouncing the user — both options
 * look like bugs. Once we know:
 *   - 0 posts → bounce to `/` (preserves bookmarked URL semantics)
 *   - ≥1 post → render the real Leaderboard page
 */
function LeaderboardGate() {
  const { hasPosts, isLoading } = useHasPosts()
  if (isLoading) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm uppercase tracking-widest text-neutral-700">
          checking…
        </p>
      </div>
    )
  }
  if (!hasPosts) return <Navigate to="/" replace />
  return <Leaderboard />
}

function Header() {
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapperRef = useRef<HTMLElement>(null)
  const location = useLocation()
  const { hasPosts, isLoading: hasPostsLoading } = useHasPosts()

  // Hide post-gated nav links (currently just /leaderboard) while we
  // don't yet know if posts exist, and after we know they don't. This
  // avoids a flicker where the link appears for a tick and then
  // vanishes once the gate query resolves.
  const visibleNavLinks = NAV_LINKS.filter((l) => {
    if (!POST_GATED_ROUTES.has(l.to)) return true
    return !hasPostsLoading && hasPosts
  })

  // Close on route change.
  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  // Close on click outside or Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  return (
    <header ref={wrapperRef} className="relative border-b-2 border-black pb-3">
      <div className="flex items-baseline justify-between gap-x-4">
        <Link
          to="/"
          className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none"
        >
          thats<span className="text-red-600">rekt</span>
        </Link>

        {/* Desktop nav + post CTA + connected account chip — hidden on
            mobile, replaced by hamburger. AccountChip self-hides when
            no wallet is connected. */}
        <div className="hidden sm:flex items-center gap-x-4">
          <nav className="flex flex-wrap gap-x-4 gap-y-1 text-xs uppercase tracking-widest">
            {visibleNavLinks.map((l) => (
              <Link key={l.to} to={l.to} className="rekt-link">
                {l.label}
              </Link>
            ))}
          </nav>
          <PostAlertButton variant="desktop" />
          <AccountChip />
        </div>

        {/* Mobile hamburger — hidden on sm+. */}
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? 'close menu' : 'open menu'}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav-menu"
          className={
            'sm:hidden inline-flex items-center justify-center w-10 h-10 border-2 border-black transition-colors touch-manipulation ' +
            (menuOpen
              ? 'bg-black text-[#f5f4ee]'
              : 'bg-[#f5f4ee] text-black hover:bg-yellow-100')
          }
        >
          {menuOpen ? <CloseIcon /> : <HamburgerIcon />}
        </button>
      </div>

      <p className="mt-2 text-xs uppercase tracking-widest text-neutral-700">
        on-chain hack alert registry for public good
      </p>

      {/* Mobile dropdown panel — only mounts when open + only visible
          below sm breakpoint. Sharp brutalist card with hard offset
          shadow, matches the InfoPopover aesthetic. */}
      {menuOpen && (
        <nav
          id="mobile-nav-menu"
          className="sm:hidden absolute right-0 top-full z-30 mt-1 w-56 border-2 border-black bg-[#f5f4ee] shadow-[4px_4px_0_0_#000]"
        >
          {/* Primary CTA at the top so it's the first thing thumb-reaches. */}
          <PostAlertButton
            variant="mobile"
            onAfterClick={() => setMenuOpen(false)}
          />
          <ul className="divide-y-2 divide-black border-t-2 border-black">
            {visibleNavLinks.map((l) => (
              <li key={l.to}>
                <Link
                  to={l.to}
                  onClick={() => setMenuOpen(false)}
                  className="block px-4 py-3 text-sm uppercase tracking-widest font-black hover:bg-yellow-100 active:bg-yellow-200"
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </header>
  )
}

function HamburgerIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-5 h-5"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M2 5h16v2H2V5zm0 4h16v2H2V9zm0 4h16v2H2v-2z"
        clipRule="evenodd"
      />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-5 h-5"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
        clipRule="evenodd"
      />
    </svg>
  )
}

function Footer() {
  return (
    <footer className="mt-16 border-t border-black pt-4 text-xs text-neutral-700">
      <p className="uppercase tracking-widest">
        public good · source on{' '}
        <a
          href="https://github.com/JeronimoHoulin/thatsRekt"
          target="_blank"
          rel="noreferrer"
          className="rekt-link"
        >
          github
        </a>
      </p>
    </footer>
  )
}

function NotFound() {
  return (
    <div className="py-16 text-center">
      <p className="text-2xl font-black uppercase">404 — rekt</p>
      <p className="mt-2 text-sm text-neutral-700">page not found</p>
      <Link to="/" className="mt-6 inline-block text-sm uppercase tracking-widest rekt-link">
        ← back to feed
      </Link>
    </div>
  )
}

function MockBanner() {
  return (
    <div className="mb-4 border-2 border-red-600 bg-red-50 px-3 py-2 text-xs uppercase tracking-widest">
      <span className="font-black text-red-600">demo mode</span>
      <span className="ml-2 text-neutral-700">
        showing dummy data · set <code className="font-mono normal-case">VITE_USE_MOCK_DATA=false</code> for live indexer
      </span>
    </div>
  )
}
