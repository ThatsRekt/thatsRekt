import { useEffect, useRef, useState } from 'react'
import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom'
import { Feed } from './pages/Feed'
import { PostDetail } from './pages/PostDetail'
import { About } from './pages/About'
import { Guardians } from './pages/Guardians'
import { Leaderboard } from './pages/Leaderboard'
import { Docs } from './pages/Docs'
import { IS_MOCK_MODE } from './lib/queries'
import { useHasPosts } from './hooks/useHasPosts'
import { useDisconnectIfNotWhitelisted } from './hooks/useDisconnectIfNotWhitelisted'
import { PostAlertButton, AccountChip } from './components/PostAlertButton'
import { TgChannelCTA, GetAlertsButton } from './components/TgChannelCTA'
import { Footer } from './components/Footer'

const NAV_LINKS: { to: string; label: string }[] = [
  { to: '/', label: 'feed' },
  { to: '/about', label: 'about' },
  { to: '/guardians', label: 'guardians' },
  { to: '/leaderboard', label: 'leaderboard' },
  { to: '/docs', label: 'docs' },
]

/** Routes that should disappear from nav + redirect to `/` when no posts exist. */
const POST_GATED_ROUTES = new Set(['/leaderboard'])

/**
 * Hard kill switch for the leaderboard surface. The page is rendered
 * but intentionally not exposed yet — flip to true when we're ready
 * to activate it. Independent of `hasPosts`: even with posts on chain,
 * we don't want the link in the nav until we've validated the
 * leaderboard's data + math against real data.
 */
const LEADERBOARD_ENABLED = false
const HARD_DISABLED_ROUTES = new Set(LEADERBOARD_ENABLED ? [] : ['/leaderboard'])

export function App() {
  // Security UX: if a connected wallet isn't whitelisted on any chain,
  // disconnect it. Mounted once at the App root so it covers every
  // entry path (gate modals, AccountChip auto-reconnect, deeplinks).
  useDisconnectIfNotWhitelisted()

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col px-6 py-10">
      {IS_MOCK_MODE && <MockBanner />}
      <Header />
      <main className="flex-1 pt-10">
        <Routes>
          <Route path="/" element={<Feed />} />
          {/*
           * Two parallel post routes:
           *   /post/:chainSlug/:postId  — clean path used by Mesh's SSR
           *                              OG card route. Preferred for
           *                              new shareable links.
           *   /post/:id                  — legacy composite-id form
           *                              (`base-42`). Kept so any
           *                              previously shared URLs don't
           *                              break. PostDetail handles
           *                              both shapes by reconstructing
           *                              the composite id when needed.
           */}
          <Route path="/post/:chainSlug/:postId" element={<PostDetail />} />
          <Route path="/post/:id" element={<PostDetail />} />
          <Route path="/about" element={<About />} />
          <Route path="/guardians" element={<Guardians />} />
          {/* Legacy `/posters` URL kept alive as a permanent redirect to
              `/guardians` — the page rebranded but inbound shared links
              from before the rename should still land somewhere useful. */}
          <Route path="/posters" element={<Navigate to="/guardians" replace />} />
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
  // Hard disable: bounce direct URL access too, matching the nav-hide.
  if (!LEADERBOARD_ENABLED) return <Navigate to="/" replace />
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
    // Hard kill switch always wins — even with posts on chain we still
    // hide leaderboard until LEADERBOARD_ENABLED is flipped.
    if (HARD_DISABLED_ROUTES.has(l.to)) return false
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
        {/* Logo + wordmark. Pixel-art skull/crossbones/ETH-diamond
            sits left of the brutalist text wordmark. Image height
            matches the wordmark cap-height visually (size set on
            sm+ to align with text-5xl). */}
        <Link
          to="/"
          className="inline-flex items-center gap-2 sm:gap-3 leading-none"
          aria-label="thatsRekt home"
        >
          <img
            src="/logo.jpg"
            alt=""
            aria-hidden="true"
            className="h-9 w-9 sm:h-11 sm:w-11 shrink-0"
          />
          <span className="font-black uppercase tracking-tighter text-4xl sm:text-5xl">
            thats<span className="text-red-600">rekt</span>
          </span>
        </Link>

        {/* Desktop CTAs + connected account chip — hidden on mobile,
            replaced by hamburger. AccountChip self-hides when no
            wallet is connected. The nav itself is moved to its own
            row below the tagline so it doesn't compete with the
            buttons for horizontal space (logo + nav + buttons + chip
            in one row was wrapping awkwardly at desktop widths). */}
        <div className="hidden sm:flex items-center gap-x-3">
          <GetAlertsButton variant="desktop" />
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

      {/* Sub-strip: tagline (left) + desktop nav (right) on the same
          horizontal level. Putting the nav here gives it room to
          breathe — no more competing with the right-side CTAs. */}
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          on-chain hack alerts for the public good
        </p>
        <nav className="hidden sm:flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs uppercase tracking-widest">
          {visibleNavLinks.map((l) => (
            <Link key={l.to} to={l.to} className="rekt-link">
              {l.label}
            </Link>
          ))}
        </nav>
      </div>

      {/* Mobile dropdown panel — only mounts when open + only visible
          below sm breakpoint. Sharp brutalist card with hard offset
          shadow, matches the InfoPopover aesthetic. */}
      {menuOpen && (
        <nav
          id="mobile-nav-menu"
          className="sm:hidden absolute right-0 top-full z-30 mt-1 w-56 border-2 border-black bg-[#f5f4ee] shadow-[4px_4px_0_0_#000]"
        >
          {/* Mobile: only Get Alerts. Post is desktop-only — composing
              a structured alert from a phone is friction-heavy (wallet
              connect + signing on small screen + careful address
              entry), and the audience for posting (whitelisted security
              teams) is desktop-bound by their workflow. Mobile users
              are readers; route them to the live channel instead. */}
          <GetAlertsButton
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
