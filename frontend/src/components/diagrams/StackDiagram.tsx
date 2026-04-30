/**
 * Stack architecture diagram for /docs.
 *
 * Vertical flow: writer → contract → indexer → gateway → reader. On the
 * sides, "shortcut" arrows show the two read paths integrators actually
 * use: reader contracts read directly from the proxy (no infra needed),
 * reader dApps query the public GraphQL gateway (rich queries).
 *
 * Brutalist style — black 2px borders, monospace labels, no gradients.
 * Pure inline SVG, no deps. Sized to flex inside the docs body width.
 */
export function StackDiagram() {
  return (
    <figure className="not-prose my-2">
      <div className="overflow-x-auto border-2 border-black bg-white p-4 sm:p-6">
        <svg
          viewBox="0 0 540 380"
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-labelledby="stack-diagram-title stack-diagram-desc"
          className="block w-full max-w-[540px] mx-auto"
        >
          <title id="stack-diagram-title">thatsRekt stack architecture</title>
          <desc id="stack-diagram-desc">
            Vertical flow: poster submits to ThatsRekt proxy on Base; events
            flow to the Subsquid indexer, then to the Mesh GraphQL gateway,
            then to the frontend. Side arrows show reader contracts and
            dApps reading directly from the proxy or the gateway.
          </desc>

          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 Z" fill="black" />
            </marker>
          </defs>

          {/* === Center column: write/index/read pipeline === */}

          {/* Poster (writer) */}
          <g>
            <rect x="200" y="10" width="140" height="50" fill="white" stroke="black" strokeWidth="2" />
            <text x="270" y="32" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fontWeight="bold">
              POSTER
            </text>
            <text x="270" y="48" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
              whitelisted EOA
            </text>
          </g>
          <line x1="270" y1="60" x2="270" y2="85" stroke="black" strokeWidth="2" markerEnd="url(#arrow)" />
          <text x="280" y="76" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
            post()
          </text>

          {/* ThatsRekt proxy contract */}
          <g>
            <rect x="180" y="90" width="180" height="60" fill="white" stroke="black" strokeWidth="2" />
            <text x="270" y="112" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fontWeight="bold">
              THATSREKT PROXY
            </text>
            <text x="270" y="128" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
              0x390f…5936 · Base
            </text>
            <text x="270" y="142" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
              same address every chain
            </text>
          </g>
          <line x1="270" y1="150" x2="270" y2="175" stroke="black" strokeWidth="2" markerEnd="url(#arrow)" />
          <text x="280" y="166" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
            events
          </text>

          {/* Indexer */}
          <g>
            <rect x="200" y="180" width="140" height="50" fill="white" stroke="black" strokeWidth="2" />
            <text x="270" y="202" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fontWeight="bold">
              INDEXER
            </text>
            <text x="270" y="218" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
              postgres-backed
            </text>
          </g>
          <line x1="270" y1="230" x2="270" y2="255" stroke="black" strokeWidth="2" markerEnd="url(#arrow)" />

          {/* GraphQL gateway */}
          <g>
            <rect x="180" y="260" width="180" height="50" fill="white" stroke="black" strokeWidth="2" />
            <text x="270" y="282" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fontWeight="bold">
              GRAPHQL GATEWAY
            </text>
            <text x="270" y="298" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
              thatsrekt.com/graphql
            </text>
          </g>
          <line x1="270" y1="310" x2="270" y2="335" stroke="black" strokeWidth="2" markerEnd="url(#arrow)" />

          {/* Frontend */}
          <g>
            <rect x="200" y="340" width="140" height="35" fill="white" stroke="black" strokeWidth="2" />
            <text x="270" y="362" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fontWeight="bold">
              THIS SITE
            </text>
          </g>

          {/* === Side arrows: reader contracts (left) and reader apps (right) === */}

          {/* Reader contract — left side, reads directly from proxy */}
          <g>
            <rect x="20" y="100" width="130" height="40" fill="white" stroke="black" strokeWidth="2" />
            <text x="85" y="121" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="10" fontWeight="bold">
              READER CONTRACT
            </text>
            <text x="85" y="134" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
              dex / wallet / lender
            </text>
          </g>
          {/* arrow from reader contract → proxy */}
          <line x1="150" y1="120" x2="180" y2="120" stroke="black" strokeWidth="2" markerEnd="url(#arrow)" />
          <text x="156" y="113" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
            reads
          </text>

          {/* Reader dApp — right side, queries GraphQL */}
          <g>
            <rect x="390" y="270" width="130" height="40" fill="white" stroke="black" strokeWidth="2" />
            <text x="455" y="291" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="10" fontWeight="bold">
              READER DAPP
            </text>
            <text x="455" y="304" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
              dashboard / risk app
            </text>
          </g>
          {/* arrow from reader dApp → graphql */}
          <line x1="390" y1="290" x2="360" y2="290" stroke="black" strokeWidth="2" markerEnd="url(#arrow)" />
          <text x="362" y="283" textAnchor="end" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
            queries
          </text>
        </svg>
      </div>
      <figcaption className="text-[10px] uppercase tracking-widest text-neutral-700 mt-2 text-center">
        [stack architecture · write top-to-bottom, read either tier]
      </figcaption>
    </figure>
  )
}
