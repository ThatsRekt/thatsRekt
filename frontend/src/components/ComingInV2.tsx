import { Link } from 'react-router-dom'
import {
  V2_DOCS_HEADING,
  V2_DOCS_SECTION_ID,
  V2_FEATURES,
  V2_FEED_HREF,
} from '../lib/v2Announcement'

/**
 * Docs preview of the v2 design. Heading id matches the feed banner
 * link and the docs TOC entry. Links back to the feed announcement.
 */
export function ComingInV2() {
  return (
    <section className="space-y-5" id={V2_DOCS_SECTION_ID}>
      <h2 className="font-black uppercase tracking-tighter text-2xl sm:text-3xl leading-none scroll-mt-6">
        {V2_DOCS_HEADING}
      </h2>
      <p className="text-base leading-relaxed text-neutral-800">
        Version 2 is in the works starting October 26, 2026. The new API
        is how you do it: reports go through the API, edits go through
        the API, and so does everything else. Nothing here is live yet.
      </p>
      <ul className="space-y-4">
        {V2_FEATURES.map((feature) => (
          <li key={feature.title} className="border-l-2 border-black pl-4">
            <p className="font-black uppercase tracking-widest text-xs">
              {feature.title}
            </p>
            <p className="text-sm leading-relaxed text-neutral-800 mt-1">
              {feature.body}
            </p>
          </li>
        ))}
      </ul>
      <p className="text-sm">
        <Link
          to={V2_FEED_HREF}
          className="rekt-link font-black uppercase tracking-widest text-xs"
        >
          announced on the feed →
        </Link>
      </p>
    </section>
  )
}
