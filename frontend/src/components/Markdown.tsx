import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Brutalist-styled Markdown renderer for post note bodies.
 *
 * Sandboxing:
 *   - `react-markdown` strips embedded HTML by default (no `rehype-raw`).
 *     Do NOT enable rehype-raw — posters are whitelisted but the security
 *     posture for onchain free-form data is "treat as untrusted display
 *     content". Stay sandboxed.
 *   - All `<a>` tags are forced through a `target="_blank"
 *     rel="noreferrer noopener"` override so a malicious `[click](javascript:...)`
 *     can't steal the rendering tab. (react-markdown also URL-filters by
 *     default, but the explicit rel/target is belt-and-braces.)
 *
 * Style:
 *   - Mirrors the brutalist site language: black borders, sharp corners,
 *     parchment background, monospace for technical content, brand red
 *     for links. We avoid `@tailwindcss/typography` and write Tailwind
 *     classes directly so the rendering matches the rest of the UI.
 *
 * Two presentation modes via the `compact` prop:
 *   - `compact: true`  → feed-card preview. Tight spacing, small text,
 *                        headings collapsed to inline-strong (so a single
 *                        `# foo` line doesn't blow up to 60px tall and
 *                        wreck card heights). Code fences are clamped to
 *                        a max height so a 200-line dump doesn't take
 *                        over the feed.
 *   - `compact: false` → full post detail. Heading scale preserved on
 *                        the brutalist rule (uppercase tracking-widest,
 *                        downsized so `#` doesn't dwarf the page H1).
 */
export function Markdown({
  source,
  compact = false,
}: {
  source: string
  compact?: boolean
}) {
  const components: Components = compact ? compactComponents : fullComponents

  return (
    <div className={compact ? compactWrapperClass : fullWrapperClass}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------
//
// Block-level vertical rhythm is owned at the wrapper level via Tailwind's
// `space-y-*` selector hitting all direct children. This avoids having to
// add a `mb-*` to every `components` override.

const fullWrapperClass =
  'space-y-3 text-base leading-relaxed text-neutral-800 break-words'

const compactWrapperClass =
  'space-y-1.5 text-sm leading-relaxed text-neutral-700 break-words'

// ---------------------------------------------------------------------------
// Shared element overrides (used by both modes)
// ---------------------------------------------------------------------------

const linkComponent: Components['a'] = ({ children, href, ...rest }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer noopener"
    className="underline text-red-700 hover:text-red-900"
    {...rest}
  >
    {children}
  </a>
)

const inlineCodeClass = 'font-mono bg-black/5 border border-black/30 px-1'

const blockquoteComponent: Components['blockquote'] = ({ children }) => (
  <blockquote className="border-l-2 border-black pl-3 italic text-neutral-700">
    {children}
  </blockquote>
)

const tableComponent: Components['table'] = ({ children }) => (
  <div className="overflow-x-auto">
    <table className="border-2 border-black text-xs">{children}</table>
  </div>
)

const thComponent: Components['th'] = ({ children }) => (
  <th className="bg-black/5 font-black uppercase tracking-widest px-2 py-1 text-left border-b-2 border-black">
    {children}
  </th>
)

const tdComponent: Components['td'] = ({ children }) => (
  <td className="border-t border-black/30 px-2 py-1 align-top">{children}</td>
)

// `code` in react-markdown 9+ is the unified inline+block renderer.
// `pre` is used as the wrapper for fenced blocks; we style the fence on
// the `<pre>` and let `<code>` inside inherit. For inline code (no `\n`,
// no language class), we render as `<code>` with the inline pill style.
const fullCodeComponent: Components['code'] = ({ children, className, ...rest }) => {
  const isBlock = /language-/.test(className ?? '')
  if (isBlock) {
    // The block-level styling lives on `<pre>` below; just pass through.
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    )
  }
  return (
    <code className={inlineCodeClass} {...rest}>
      {children}
    </code>
  )
}

const fullPreComponent: Components['pre'] = ({ children }) => (
  <pre className="border-2 border-black bg-black text-[#f5f4ee] font-mono text-xs px-3 py-2 overflow-x-auto">
    {children}
  </pre>
)

// In compact mode, code fences get a max-height so a long dump doesn't
// blow up the feed card. The wrapping container in PostCard already adds
// a fade-out, but capping the inner block keeps the fade meaningful.
const compactPreComponent: Components['pre'] = ({ children }) => (
  <pre className="border-2 border-black bg-black text-[#f5f4ee] font-mono text-[11px] px-3 py-2 overflow-hidden max-h-32">
    {children}
  </pre>
)

const ulComponent: Components['ul'] = ({ children }) => (
  <ul className="list-disc list-inside space-y-0.5">{children}</ul>
)

const olComponent: Components['ol'] = ({ children }) => (
  <ol className="list-decimal list-inside space-y-0.5">{children}</ol>
)

const hrComponent: Components['hr'] = () => (
  <hr className="border-t-2 border-black" />
)

// ---------------------------------------------------------------------------
// Full mode — preserves heading hierarchy at a downsized scale.
// ---------------------------------------------------------------------------
//
// h1-h6 in a post body must NOT dwarf the page title (the actual <h1> on
// the post detail page is `text-3xl/4xl font-black`). Map them all to a
// brutalist sub-heading scale: h1 → text-base, h2 → text-sm, h3+ → text-sm
// non-uppercase. Anything bigger than that fights the page layout.

const fullHeadingComponents: Pick<Components, 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'> = {
  h1: ({ children }) => (
    <h3 className="text-base font-black uppercase tracking-widest mt-4">{children}</h3>
  ),
  h2: ({ children }) => (
    <h4 className="text-sm font-black uppercase tracking-widest mt-3">{children}</h4>
  ),
  h3: ({ children }) => (
    <h5 className="text-sm font-black uppercase tracking-widest mt-2">{children}</h5>
  ),
  h4: ({ children }) => (
    <h6 className="text-sm font-black uppercase tracking-widest mt-2">{children}</h6>
  ),
  h5: ({ children }) => (
    <h6 className="text-sm font-black uppercase tracking-widest mt-2">{children}</h6>
  ),
  h6: ({ children }) => (
    <h6 className="text-sm font-black uppercase tracking-widest mt-2">{children}</h6>
  ),
}

const fullComponents: Components = {
  a: linkComponent,
  code: fullCodeComponent,
  pre: fullPreComponent,
  blockquote: blockquoteComponent,
  table: tableComponent,
  th: thComponent,
  td: tdComponent,
  ul: ulComponent,
  ol: olComponent,
  hr: hrComponent,
  ...fullHeadingComponents,
}

// ---------------------------------------------------------------------------
// Compact mode — collapses headings to inline-strong text.
// ---------------------------------------------------------------------------
//
// In a feed card preview, a `# heading` line shouldn't introduce a 24px
// block break — it should look like the rest of the body text. Collapse
// h1-h6 to a strong span so they're visually identifiable as emphasis
// without breaking card layout.

const compactHeading: Components['h1'] = ({ children }) => (
  <span className="font-black uppercase tracking-widest text-xs">{children}</span>
)

const compactComponents: Components = {
  a: linkComponent,
  code: fullCodeComponent, // same inline/block split logic; the <pre> wrapper differs
  pre: compactPreComponent,
  blockquote: blockquoteComponent,
  table: tableComponent,
  th: thComponent,
  td: tdComponent,
  ul: ulComponent,
  ol: olComponent,
  hr: hrComponent,
  h1: compactHeading,
  h2: compactHeading,
  h3: compactHeading,
  h4: compactHeading,
  h5: compactHeading,
  h6: compactHeading,
}
