import { Routes, Route, Link } from 'react-router-dom'
import { Feed } from './pages/Feed'
import { PostDetail } from './pages/PostDetail'
import { Donate } from './pages/Donate'
import { Contributors } from './pages/Contributors'
import { IS_MOCK_MODE } from './lib/queries'

export function App() {
  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col px-6 py-10">
      {IS_MOCK_MODE && <MockBanner />}
      <Header />
      <main className="flex-1 pt-10">
        <Routes>
          <Route path="/" element={<Feed />} />
          <Route path="/post/:id" element={<PostDetail />} />
          <Route path="/contributors" element={<Contributors />} />
          <Route path="/donate" element={<Donate />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}

function Header() {
  return (
    <header className="border-b-2 border-black pb-3">
      <div className="flex items-baseline justify-between">
        <Link to="/" className="font-black uppercase tracking-tighter text-5xl leading-none">
          thats<span className="text-red-600">rekt</span>
        </Link>
        <nav className="flex gap-4 text-xs uppercase tracking-widest">
          <Link to="/" className="rekt-link">feed</Link>
          <Link to="/contributors" className="rekt-link">contributors</Link>
          <Link to="/donate" className="rekt-link text-red-600 font-black">
            donate
          </Link>
          <a
            href="https://github.com/JeronimoHoulin/thatsRekt"
            target="_blank"
            rel="noreferrer"
            className="rekt-link"
          >
            github
          </a>
        </nav>
      </div>
      <p className="mt-2 text-xs uppercase tracking-widest text-neutral-700">
        on-chain hack alert registry for public good
      </p>
    </header>
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
