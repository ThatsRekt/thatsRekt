/**
 * Post lifecycle diagram for /docs.
 *
 * Shows the full lifecycle of a single alert post: poster submits via the
 * contract, peers confirm or refute, and the aggregate `attackerScore`
 * updates in real time. Aggregates flow back to readers (contracts and
 * dApps) without indexer dependency for the cheap on-chain reads.
 *
 * Brutalist style — black 2px borders, monospace labels, no gradients.
 */
export function PostLifecycleDiagram() {
  return (
    <figure className="not-prose my-2">
      <div className="overflow-x-auto border-2 border-black bg-white p-4 sm:p-6">
        <svg
          viewBox="0 0 540 380"
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-labelledby="lifecycle-diagram-title lifecycle-diagram-desc"
          className="block w-full max-w-[540px] mx-auto"
        >
          <title id="lifecycle-diagram-title">post lifecycle</title>
          <desc id="lifecycle-diagram-desc">
            A poster submits an alert via post(); peers call confirm() with
            Up or Down; the contract updates attackerScore in real time;
            integrators read the score directly with a single view call.
          </desc>

          <defs>
            <marker
              id="arrow2"
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

          {/* Step 1: poster submits */}
          <g>
            <rect x="20" y="20" width="120" height="55" fill="white" stroke="black" strokeWidth="2" />
            <text x="80" y="38" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fontWeight="bold" fill="#525252">
              [step 1]
            </text>
            <text x="80" y="54" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fontWeight="bold">
              POSTER
            </text>
            <text x="80" y="68" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
              spots an attack
            </text>
          </g>
          <line x1="140" y1="48" x2="200" y2="48" stroke="black" strokeWidth="2" markerEnd="url(#arrow2)" />
          <text x="170" y="42" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
            post()
          </text>

          {/* Step 2: contract creates post */}
          <g>
            <rect x="200" y="20" width="160" height="55" fill="white" stroke="black" strokeWidth="2" />
            <text x="280" y="38" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fontWeight="bold" fill="#525252">
              [step 2]
            </text>
            <text x="280" y="54" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fontWeight="bold">
              CONTRACT
            </text>
            <text x="280" y="68" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
              stores post · emits event
            </text>
          </g>

          {/* Step 3: peers confirm/disconfirm */}
          <line x1="280" y1="75" x2="280" y2="115" stroke="black" strokeWidth="2" markerEnd="url(#arrow2)" />
          <text x="290" y="100" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
            confirm()
          </text>

          <g>
            <rect x="180" y="120" width="200" height="60" fill="white" stroke="black" strokeWidth="2" />
            <text x="280" y="138" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fontWeight="bold" fill="#525252">
              [step 3]
            </text>
            <text x="280" y="154" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fontWeight="bold">
              PEER WHITELISTERS
            </text>
            <text x="280" y="170" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
              vouch (Up +1) · refute (Down -1)
            </text>
          </g>

          {/* Step 4: contract updates aggregate */}
          <line x1="280" y1="180" x2="280" y2="215" stroke="black" strokeWidth="2" markerEnd="url(#arrow2)" />
          <text x="290" y="202" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
            updates
          </text>

          <g>
            <rect x="160" y="220" width="240" height="65" fill="white" stroke="black" strokeWidth="2" />
            <text x="280" y="240" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fontWeight="bold" fill="#525252">
              [step 4]
            </text>
            <text x="280" y="258" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fontWeight="bold">
              AGGREGATE STATE
            </text>
            <text x="280" y="274" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
              attackerScore · isVictim · per-post counts
            </text>
          </g>

          {/* Step 5: readers consume */}
          <line x1="280" y1="285" x2="280" y2="315" stroke="black" strokeWidth="2" markerEnd="url(#arrow2)" />
          <text x="290" y="305" fontFamily="ui-monospace, monospace" fontSize="9" fill="#525252">
            view calls
          </text>

          {/* Reader contract - left */}
          <g>
            <rect x="40" y="320" width="200" height="50" fill="white" stroke="black" strokeWidth="2" />
            <text x="140" y="340" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fontWeight="bold" fill="#525252">
              [step 5a]
            </text>
            <text x="140" y="356" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="10" fontWeight="bold">
              READER CONTRACT
            </text>
          </g>
          <line x1="240" y1="345" x2="280" y2="320" stroke="black" strokeWidth="2" markerStart="url(#arrow2)" />

          {/* Reader dApp - right */}
          <g>
            <rect x="320" y="320" width="200" height="50" fill="white" stroke="black" strokeWidth="2" />
            <text x="420" y="340" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fontWeight="bold" fill="#525252">
              [step 5b]
            </text>
            <text x="420" y="356" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="10" fontWeight="bold">
              READER DAPP
            </text>
          </g>
          <line x1="320" y1="345" x2="280" y2="320" stroke="black" strokeWidth="2" markerStart="url(#arrow2)" />
        </svg>
      </div>
      <figcaption className="text-[10px] uppercase tracking-widest text-neutral-700 mt-2 text-center">
        [post lifecycle · single tx to post, single view call to read]
      </figcaption>
    </figure>
  )
}
