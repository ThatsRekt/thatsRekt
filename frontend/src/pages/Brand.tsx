import { CopyableText } from '../components/CopyableText'

/**
 * "/brand" — the public brand kit.
 *
 * A static reference surface assembled entirely from the project's own
 * design system, so the page both documents the brand and demonstrates
 * it. Standard kit: the mark, the wordmark/lockup, the color palette
 * (copyable hex), typography, a short voice note, and downloads for the
 * existing asset files plus a vector wordmark.
 *
 * Linked from the footer ("[brand]") — reference, not a primary nav
 * surface, so it stays out of the top nav.
 *
 * Sections mirror About.tsx's structure: an <article> with spaced
 * sections, each headed by a brutalist h2 + a [bracketed] subtitle.
 */

/** The brutalist palette, derived from index.css + tailwind usage. */
const PALETTE: { name: string; role: string; hex: string }[] = [
  { name: 'canvas', role: 'page background', hex: '#f5f4ee' },
  { name: 'ink', role: 'body text', hex: '#0a0a0a' },
  { name: 'black', role: 'borders / rules', hex: '#000000' },
  { name: 'rekt red', role: 'accent / alerts', hex: '#dc2626' },
  { name: 'highlight', role: 'hover / emphasis', hex: '#fef08a' },
]

/** Downloadable assets. Every href resolves to a file in /public. */
const DOWNLOADS: { href: string; label: string; note: string }[] = [
  { href: '/logo.png', label: 'mark (PNG)', note: 'pixel-art mark · 1008×1046 · transparent' },
  { href: '/brand/thatsrekt-wordmark.svg', label: 'wordmark (SVG)', note: 'vector lockup · scalable' },
  { href: '/favicon.svg', label: 'favicon (SVG)', note: 'browser tab icon · vector' },
  { href: '/og-image-default.png', label: 'social card (PNG)', note: 'default open-graph · 1200×630' },
]

export function Brand() {
  return (
    <article className="space-y-12">
      <Hero />
      <TheMark />
      <Wordmark />
      <Colors />
      <Typography />
      <Voice />
      <Downloads />
    </article>
  )
}

function SectionHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <header className="space-y-1">
      <h2 className="font-black uppercase tracking-tighter text-2xl sm:text-3xl leading-none">
        {title}
      </h2>
      <p className="text-xs uppercase tracking-widest text-neutral-700">{sub}</p>
    </header>
  )
}

function Hero() {
  return (
    <header className="space-y-3">
      <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
        brand kit
      </h1>
      <p className="text-xs uppercase tracking-widest text-neutral-700">
        [assets · colors · type]
      </p>
      <p className="max-w-prose text-sm leading-relaxed text-neutral-800">
        Everything you need to reference, cite, or integrate thatsRekt.
        All assets are MIT-licensed — use them to link to the registry,
        credit the project, or build it into your own tooling. Keep the
        mark crisp and the wordmark intact; don't recolor or restyle them.
      </p>
    </header>
  )
}

function TheMark() {
  return (
    <section className="space-y-4">
      <SectionHeader title="the mark" sub="[skull · crossbones · eth diamond]" />
      <div className="flex flex-col sm:flex-row sm:items-center gap-6">
        <div className="shrink-0 border-2 border-black bg-[#f5f4ee] p-6 shadow-[4px_4px_0_0_#000]">
          {/* Pixel art: render at intrinsic-ish size, crisp edges. */}
          <img
            src="/logo.png"
            alt="thatsRekt mark"
            width={96}
            height={96}
            className="h-24 w-24"
            style={{ imageRendering: 'pixelated' }}
          />
        </div>
        <ul className="space-y-2 text-sm leading-relaxed text-neutral-800">
          <li>
            <span className="font-black uppercase tracking-widest text-xs">clear space</span>{' '}
            — keep padding around the mark at least equal to a quarter of its height.
          </li>
          <li>
            <span className="font-black uppercase tracking-widest text-xs">min size</span>{' '}
            — don't render below 24px; the pixels lose legibility.
          </li>
          <li>
            <span className="font-black uppercase tracking-widest text-xs">keep it crisp</span>{' '}
            — it's pixel art. Scale by whole multiples and disable smoothing; never blur or anti-alias.
          </li>
          <li>
            <span className="font-black uppercase tracking-widest text-xs">don't</span>{' '}
            — recolor, rotate, stretch, or add effects.
          </li>
        </ul>
      </div>
    </section>
  )
}

function Wordmark() {
  return (
    <section className="space-y-4">
      <SectionHeader title="wordmark" sub="[lockup · construction]" />
      <div className="border-2 border-black bg-[#f5f4ee] px-6 py-8 shadow-[4px_4px_0_0_#000]">
        {/* The live wordmark, identical to the header. */}
        <span className="font-black uppercase tracking-tighter text-5xl sm:text-6xl leading-none">
          thats<span className="text-red-600">rekt</span>
        </span>
      </div>
      <p className="max-w-prose text-sm leading-relaxed text-neutral-800">
        One word, all lowercase in prose, all caps in the lockup:{' '}
        <span className="font-mono">font-black uppercase tracking-tighter</span>, with
        “rekt” set in <span className="font-mono">rekt red (#dc2626)</span> against ink.
        The full lockup pairs the mark to the left of the wordmark, cap-height aligned —
        exactly as it appears in the site header.
      </p>
    </section>
  )
}

function Colors() {
  return (
    <section className="space-y-4">
      <SectionHeader title="colors" sub="[click any hex to copy]" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {PALETTE.map((c) => (
          <Swatch key={c.hex} {...c} />
        ))}
      </div>
    </section>
  )
}

function Swatch({ name, role, hex }: { name: string; role: string; hex: string }) {
  return (
    <div className="border-2 border-black">
      <div className="h-20 border-b-2 border-black" style={{ backgroundColor: hex }} />
      <div className="space-y-2 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-black uppercase tracking-widest text-xs">{name}</span>
          <span className="text-[10px] uppercase tracking-widest text-neutral-600">{role}</span>
        </div>
        <CopyableText value={hex} copyAriaLabel={`Copy ${name} hex ${hex}`} />
      </div>
    </div>
  )
}

function Typography() {
  return (
    <section className="space-y-4">
      <SectionHeader title="typography" sub="[ui · technical]" />
      <div className="space-y-4">
        <div className="border-2 border-black bg-[#f5f4ee] p-4">
          <p className="text-[10px] uppercase tracking-widest text-neutral-600 mb-2">
            [ui / body]
          </p>
          <p className="text-2xl font-black">Inter, then system-ui fallback</p>
          <p className="mt-1 text-sm text-neutral-800">
            Headings: black weight, uppercase, tight tracking. Labels: uppercase,
            wide tracking, small. Body copy stays sentence case.
          </p>
        </div>
        <div className="border-2 border-black bg-[#f5f4ee] p-4">
          <p className="text-[10px] uppercase tracking-widest text-neutral-600 mb-2">
            [technical / addresses]
          </p>
          <p className="text-xl font-mono">0xBfaEEE…b89A · ui-monospace</p>
          <p className="mt-1 text-sm text-neutral-800">
            Monospace for addresses, hashes, code, and endpoints.
          </p>
        </div>
      </div>
    </section>
  )
}

function Voice() {
  return (
    <section className="space-y-4">
      <SectionHeader title="voice" sub="[terse · brutalist]" />
      <div className="space-y-3 max-w-prose text-sm leading-relaxed text-neutral-800">
        <p>
          Lowercase, terse, plainspoken. State facts; skip hype. The registry
          is a public good, and the copy should read like infrastructure — not
          marketing.
        </p>
        <p className="font-black uppercase tracking-tighter text-xl text-neutral-900">
          “onchain hack alerts for the public good”
        </p>
      </div>
    </section>
  )
}

function Downloads() {
  return (
    <section className="space-y-4">
      <SectionHeader title="downloads" sub="[mit-licensed assets]" />
      <ul className="divide-y-2 divide-black border-2 border-black">
        {DOWNLOADS.map((d) => (
          <li key={d.href}>
            <a
              href={d.href}
              download
              className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-yellow-100 active:bg-yellow-200 transition-colors"
            >
              <span className="min-w-0">
                <span className="block font-black uppercase tracking-widest text-sm">
                  {d.label}
                </span>
                <span className="block text-[11px] text-neutral-600 font-mono break-all">
                  {d.note}
                </span>
              </span>
              <span aria-hidden="true" className="shrink-0 text-lg">
                ↓
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}
