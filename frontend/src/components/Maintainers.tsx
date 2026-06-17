import { twitterUrl } from '../lib/format'

/**
 * Static maintainer list. Hardcoded — there are three maintainers and they
 * change rarely; reading from a config file would be over-engineering.
 */
export function Maintainers() {
  return (
    <section className="space-y-3 border-2 border-black bg-yellow-50 p-5">
      <h2 className="font-black uppercase tracking-widest text-xs">
        maintainers
      </h2>
      <p className="text-sm leading-relaxed text-neutral-800">
        thatsRekt is maintained by{' '}
        <Maintainer
          name="jerrythekid"
          twitter="jerrythekid"
          github="JeronimoHoulin"
          ens="jerrythekid.eth"
        />,{' '}
        <Maintainer
          name="bauti.eth"
          twitter="BautiDeFi"
          github="bauti-defi"
          ens="bauti.eth"
        />, and{' '}
        <Maintainer
          name="ohdatskate.eth"
          twitter="ohdatskate"
          telegram="ohdatskate"
          ens="ohdatskate.eth"
        />.
      </p>
    </section>
  )
}

function Maintainer({
  name,
  twitter,
  telegram,
  github,
  ens,
}: {
  name: string
  twitter?: string
  telegram?: string
  github?: string
  ens?: string
}) {
  const links: { label: string; href: string }[] = []
  if (twitter) links.push({ label: 'x', href: twitterUrl(twitter) })
  if (telegram) links.push({ label: 'tg', href: `https://t.me/${telegram}` })
  if (github) links.push({ label: 'gh', href: `https://github.com/${github}` })
  if (ens) links.push({ label: 'ens', href: `https://app.ens.domains/${ens}` })

  return (
    <span className="inline-flex items-baseline gap-1 font-black">
      {name}
      <span className="font-normal text-neutral-500">[</span>
      {links.map((l, i) => (
        <span key={l.label} className="inline-flex items-baseline gap-1">
          {i > 0 && <span className="font-normal text-neutral-500">·</span>}
          <a
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs uppercase tracking-widest rekt-link"
          >
            {l.label}
          </a>
        </span>
      ))}
      <span className="font-normal text-neutral-500">]</span>
    </span>
  )
}
