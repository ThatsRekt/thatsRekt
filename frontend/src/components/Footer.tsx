import { Link } from 'react-router-dom'
import { TG_CHANNEL_URL } from './TgChannelCTA'
import { twitterUrl } from '../lib/format'

/**
 * Site-wide footer rendered after every routed page.
 *
 * Three-column brutalist grid (collapses to one column on mobile)
 * surfacing the project's external surfaces — public alerts channel,
 * source code, and a how-to-apply contact path. Bottom strip is
 * license + maintainer credits.
 *
 * The contracts deployment list lives on the Docs page (under
 * `[reference] / [deployments]`) — it's reference data, not a
 * call-to-action, so it doesn't earn space here.
 *
 * Visual rules: top border 2px black to separate from page content,
 * page background (`#f5f4ee`) to feel continuous with the layout, mono
 * for tech links, lowercase brutalist voice. No icons; arrows are
 * unicode glyphs.
 */

const GITHUB_URL = 'https://github.com/ThatsRekt/thatsRekt'
const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues`
/** Project X (Twitter) account — distinct from any maintainer's
 *  personal handle (those go on the bottom credits line). */
const PROJECT_X_URL = 'https://x.com/ThatsRekt_'

export function Footer() {
  return (
    <footer className="mt-16 border-t-2 border-black bg-[#f5f4ee] py-8 sm:py-10">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
        <BrandColumn />
        <CommunityColumn />
        <ContactColumn />
      </div>
      <BottomBar />
    </footer>
  )
}

function ColumnHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] uppercase tracking-widest font-black text-neutral-700 mb-3">
      {children}
    </p>
  )
}

function BrandColumn() {
  return (
    <div>
      <ColumnHeading>[thatsrekt]</ColumnHeading>
      <p className="text-xs leading-relaxed text-neutral-800 mb-3">
        onchain hack alerts for the public good.
      </p>
      <ul className="space-y-1.5">
        <li>
          <Link to="/" className="text-[11px] uppercase tracking-widest font-mono rekt-link">
            feed
          </Link>
        </li>
        <li>
          <Link to="/about" className="text-[11px] uppercase tracking-widest font-mono rekt-link">
            about
          </Link>
        </li>
        <li>
          <Link to="/guardians" className="text-[11px] uppercase tracking-widest font-mono rekt-link">
            guardians
          </Link>
        </li>
        <li>
          <Link to="/docs" className="text-[11px] uppercase tracking-widest font-mono rekt-link">
            docs
          </Link>
        </li>
      </ul>
    </div>
  )
}

function CommunityColumn() {
  return (
    <div>
      <ColumnHeading>[community]</ColumnHeading>
      <ul className="space-y-1.5">
        <li>
          <a
            href={TG_CHANNEL_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] uppercase tracking-widest font-mono rekt-link"
          >
            [telegram alerts <span aria-hidden="true">↗</span>]
          </a>
        </li>
        <li>
          <a
            href={PROJECT_X_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] uppercase tracking-widest font-mono rekt-link"
          >
            [x / twitter <span aria-hidden="true">↗</span>]
          </a>
        </li>
        <li>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] uppercase tracking-widest font-mono rekt-link"
          >
            [github <span aria-hidden="true">↗</span>]
          </a>
        </li>
      </ul>
    </div>
  )
}

function ContactColumn() {
  return (
    <div>
      <ColumnHeading>[contact]</ColumnHeading>
      <ul className="space-y-1.5">
        <li>
          <Link
            to="/apply"
            className="text-[11px] uppercase tracking-widest font-mono rekt-link"
          >
            apply to guard <span aria-hidden="true">→</span>
          </Link>
        </li>
        <li>
          <a
            href={GITHUB_ISSUES_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] uppercase tracking-widest font-mono rekt-link"
          >
            report an issue <span aria-hidden="true">→</span>
          </a>
        </li>
      </ul>
    </div>
  )
}

/**
 * Maintainer credits link to each maintainer's X profile (same handles
 * exposed in the `Maintainers` component on the About page). ENS names
 * read as the canonical onchain identity; X is where commentary lives.
 */
function BottomBar() {
  return (
    <div className="mt-8 pt-4 border-t border-black/30 text-[10px] uppercase tracking-widest text-neutral-600">
      licensed under MIT &nbsp;·&nbsp; built by{' '}
      <a
        href={twitterUrl('jerrythekid')}
        target="_blank"
        rel="noreferrer noopener"
        className="rekt-link font-mono"
      >
        jerrythekid.eth
      </a>{' '}
      &amp;{' '}
      <a
        href={twitterUrl('BautiDeFi')}
        target="_blank"
        rel="noreferrer noopener"
        className="rekt-link font-mono"
      >
        bauti.eth
      </a>
      &nbsp;·&nbsp; v0.1
    </div>
  )
}
