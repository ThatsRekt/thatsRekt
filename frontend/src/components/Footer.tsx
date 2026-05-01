import { Link } from 'react-router-dom'
import { TG_CHANNEL_URL } from './TgChannelCTA'

/**
 * Site-wide footer rendered after every routed page.
 *
 * Four-column brutalist grid (collapses to one column on mobile) that
 * surfaces the project's key external surfaces — registry contracts on
 * Base + Optimism, the public Telegram alert channel, source code, and
 * a how-to-apply contact path. Bottom strip is the standard
 * license/credits/version line.
 *
 * Visual rules: top border 2px black to separate from page content,
 * page background (`#f5f4ee`) to feel continuous with the layout, mono
 * for tech links, lowercase brutalist voice. No icons; arrows are
 * unicode glyphs.
 */

const GITHUB_URL = 'https://github.com/JeronimoHoulin/thatsRekt'
const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues`
const APPLY_EMAIL = 'thatsrekt@protonmail.com'

const BASE_PROXY = '0x390f7b37545CaD278dD3DADC92a20b9f45865936'
const OPTIMISM_PROXY = '0x75bDe0394Dd0D92a2cEd1E0E4Fd5abB21319fD0e'
const BASE_EXPLORER_URL = `https://basescan.org/address/${BASE_PROXY}`
const OPTIMISM_EXPLORER_URL = `https://optimistic.etherscan.io/address/${OPTIMISM_PROXY}`

function truncateAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/**
 * Build the same mailto string `WhitelistGateModal` uses, minus the
 * connected-address line (footer has no wallet context). Keeping
 * subject + body wording identical means inbound applications land in
 * the same triage bucket regardless of which surface the user clicked.
 */
function buildApplyMailto(): string {
  const subject = encodeURIComponent('thatsRekt — vetted poster application')
  const bodyLines = [
    'Team / detector name:',
    'Public profile (X / GitHub / website):',
    'Detection focus (which protocols, chains, exploit classes):',
    'Existing track record (writeups, prior incidents flagged):',
    'Address to whitelist:',
    '',
    "We'll review and reply with next steps.",
  ]
  return `mailto:${APPLY_EMAIL}?subject=${subject}&body=${encodeURIComponent(bodyLines.join('\n'))}`
}

export function Footer() {
  return (
    <footer className="mt-16 border-t-2 border-black bg-[#f5f4ee] py-8 sm:py-10">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
        <BrandColumn />
        <OnchainColumn />
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
        free real-time hack alerts for evm chains, public good.
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
          <Link to="/posters" className="text-[11px] uppercase tracking-widest font-mono rekt-link">
            posters
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

function OnchainColumn() {
  return (
    <div>
      <ColumnHeading>[onchain]</ColumnHeading>
      <ul className="space-y-2">
        <li>
          <a
            href={BASE_EXPLORER_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="block group"
            aria-label={`view base mainnet contract ${BASE_PROXY} on basescan`}
          >
            <span className="block text-[11px] uppercase tracking-widest font-black text-neutral-800 group-hover:text-red-600">
              base mainnet <span aria-hidden="true">↗</span>
            </span>
            <span className="block font-mono text-[10px] text-neutral-600">
              {truncateAddr(BASE_PROXY)}
            </span>
          </a>
        </li>
        <li>
          <a
            href={OPTIMISM_EXPLORER_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="block group"
            aria-label={`view optimism mainnet contract ${OPTIMISM_PROXY} on optimistic etherscan`}
          >
            <span className="block text-[11px] uppercase tracking-widest font-black text-neutral-800 group-hover:text-red-600">
              optimism mainnet <span aria-hidden="true">↗</span>
            </span>
            <span className="block font-mono text-[10px] text-neutral-600">
              {truncateAddr(OPTIMISM_PROXY)}
            </span>
          </a>
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
            [telegram <span aria-hidden="true">↗</span>]
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
  const mailto = buildApplyMailto()
  return (
    <div>
      <ColumnHeading>[contact]</ColumnHeading>
      <ul className="space-y-1.5">
        <li>
          <a
            href={mailto}
            className="text-[11px] uppercase tracking-widest font-mono rekt-link"
          >
            become a poster — apply <span aria-hidden="true">→</span>
          </a>
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

function BottomBar() {
  return (
    <div className="mt-8 pt-4 border-t border-black/30 text-[10px] uppercase tracking-widest text-neutral-600">
      licensed under MIT &nbsp;·&nbsp; built by jerry &amp; bauti &nbsp;·&nbsp; v0.1
    </div>
  )
}
