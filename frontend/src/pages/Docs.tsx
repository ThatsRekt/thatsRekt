import { BecomeAPosterCallout } from '../components/BecomeAPosterCallout'

/**
 * Single-page docs for integrators. Plain JSX (no MDX, no syntax
 * highlighter) — keeps the bundle lean. Migrate to a proper docs site
 * (Docusaurus / Mintlify / vitepress) when this page outgrows the format.
 */
export function Docs() {
  return (
    <article className="space-y-12">
      <Hero />
      <WhatIs />
      <HowItWorks />
      <BecomeAPosterCallout />
      <Architecture />
      <SolidityIntegration />
      <DappIntegration />
      <Reference />
    </article>
  )
}

function Hero() {
  return (
    <header className="space-y-3 border-b-2 border-black pb-6">
      <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
        docs
      </h1>
      <p className="text-xs uppercase tracking-widest text-neutral-700">
        [for protocols, integrators, and the curious]
      </p>
    </header>
  )
}

// =============================================================================
// What is thatsRekt
// =============================================================================

function WhatIs() {
  return (
    <Section heading="what is thatsRekt">
      <p className="text-base leading-relaxed text-neutral-800">
        thatsRekt is an{' '}
        <strong className="font-black">on-chain hack alert registry</strong>.
        Whitelisted operators post structured alerts about active DeFi
        exploits — attacker addresses, victim contracts, and a
        free-form note. Other whitelisters race to{' '}
        <em>vouch</em> (confirm) or <em>refute</em> (disconfirm).
      </p>
      <p className="text-base leading-relaxed text-neutral-800">
        Other contracts read this state directly: a bridge can refuse
        to release funds to a recipient with a high{' '}
        <code className="font-mono text-sm">attackerScore</code>, a
        wallet can warn before sending to a flagged address, a lending
        market can pause when its own contracts are reported under
        attack. The registry is permissioned to write but{' '}
        <strong className="font-black">open to read</strong> — every
        score, post, and confirmer set is queryable from any contract
        or app.
      </p>
    </Section>
  )
}

// =============================================================================
// How posts work
// =============================================================================

function HowItWorks() {
  return (
    <Section heading="how posts work">
      <SubSection heading="whitelisters">
        Authorized addresses (the "posters" listed under{' '}
        <Inline>/posters</Inline>). They can call{' '}
        <Code>post(...)</Code>, <Code>confirm(...)</Code>, and{' '}
        <Code>disconfirm(...)</Code>. Posts include a title, attacker
        addresses, victim contracts, and a free-form note. Confirmer
        identities are public on-chain.
      </SubSection>
      <SubSection heading="governance">
        A multisig controls the whitelist and can upgrade the contract
        — but every change goes through a{' '}
        <strong className="font-black">7-day TimelockController</strong>.
        Integrators always have a week to disengage if a malicious
        change is queued.
      </SubSection>
      <SubSection heading="integrators">
        Anyone reading the registry. Two main signals: an address's{' '}
        <Code>attackerScore</Code> (signed integer — sum of
        confirmations minus disconfirmations across every post that
        names the address as an attacker) and an address's{' '}
        <Code>isVictim</Code> flag (true if the address is currently
        the target of an active alert). Both are readable on-chain in
        a single view call.
      </SubSection>
    </Section>
  )
}

// =============================================================================
// Architecture
// =============================================================================

function Architecture() {
  return (
    <Section heading="architecture">
      <p className="text-base leading-relaxed text-neutral-800">
        Single Solidity contract per chain, deployed at the same
        address on every supported chain via deterministic CREATE2.
        One integration constant works everywhere your protocol is
        deployed.
      </p>

      <SubSection heading="public read functions">
        <p className="text-sm leading-relaxed text-neutral-800 mb-2">
          Anyone can call these — no whitelist needed. This is what
          dApps, indexers, and on-chain integrators consume.
        </p>
        <ul className="space-y-1 text-sm leading-relaxed text-neutral-800 list-disc list-inside marker:text-neutral-400">
          <li>
            <Code>attackerReport(address)</Code> →{' '}
            <Inline>(int256 score, uint256 appearances)</Inline>.
            Signed score from confirmer activity, plus how many posts
            list this address as an attacker.
          </li>
          <li>
            <Code>isVictim(address)</Code> →{' '}
            <Inline>bool</Inline>. True when the address is the
            target of at least one currently-active alert.
          </li>
          <li>
            <Code>getPost(uint256 id)</Code> → full post struct
            (poster, attackedAt, title, note, attackers, victims,
            confirmations, disconfirmations, removed).
          </li>
          <li>
            <Code>recentActivePosts(uint256 limit)</Code> → array of
            recent post ids that haven't been retracted.
          </li>
          <li>
            <Code>activePostsBefore(uint256 beforeId, uint256 limit)</Code>{' '}
            → cursor-paginated walk through active history.
          </li>
          <li>
            <Code>getConfirmers(uint256 postId)</Code> /{' '}
            <Code>getDisconfirmers(uint256 postId)</Code> → confirmer
            sets per direction.
          </li>
          <li>
            <Code>getConfirmerCount(uint256 postId)</Code> /{' '}
            <Code>getDisconfirmerCount(uint256 postId)</Code> → cheap
            counts when you don't need the full set.
          </li>
        </ul>
      </SubSection>

      <SubSection heading="whitelisted write functions">
        <p className="text-sm leading-relaxed text-neutral-800 mb-2">
          Only addresses on the whitelist can call these. They're
          what posters use to submit and curate alerts.
        </p>
        <ul className="space-y-1 text-sm leading-relaxed text-neutral-800 list-disc list-inside marker:text-neutral-400">
          <li>
            <Code>post(title, attackers, victims, note, attackedAt)</Code>{' '}
            → submit a new alert. Returns the new post id.
          </li>
          <li>
            <Code>confirm(postId, direction)</Code> → vouch (
            <Inline>Up</Inline>) or refute (<Inline>Down</Inline>) an
            existing post. One vote per address per post; calling
            again switches direction.
          </li>
          <li>
            <Code>unconfirm(postId)</Code> → withdraw your existing
            confirmation or disconfirmation.
          </li>
          <li>
            <Code>retract(postId)</Code> → pull your own post (only
            the original poster can retract).
          </li>
          <li>
            <Code>amendNote(postId, newNote)</Code> /{' '}
            <Code>amendTitle(postId, newTitle)</Code> → edit your own
            post's note or title.
          </li>
          <li>
            <Code>addAttackers(postId, addrs)</Code> /{' '}
            <Code>addVictims(postId, addrs)</Code> → append addresses
            to your own post (no removal — the audit trail is
            append-only).
          </li>
        </ul>
      </SubSection>

      <SubSection heading="cross-chain identity">
        Posters are EOAs whitelisted independently per chain — the
        same address can post on every chain because CREATE2 makes
        the proxy address identical everywhere. The leaderboard
        aggregates a poster's lifetime activity across chains by
        address.
      </SubSection>

      <SubSection heading="off-chain pipeline (optional)">
        For whitelisted operators running automated detectors that
        can't sign transactions themselves, the{' '}
        <Inline>relay/</Inline> service in the monorepo provides a
        webhook-driven submission path. Single-tenant — bring your
        own EOA + bearer token. See{' '}
        <a
          href="https://github.com/JeronimoHoulin/thatsRekt/blob/master/relay/README.md"
          target="_blank"
          rel="noopener noreferrer"
          className="rekt-link"
        >
          relay/README.md ↗
        </a>{' '}
        for the full spec.
      </SubSection>
    </Section>
  )
}

// =============================================================================
// Solidity integration
// =============================================================================

function SolidityIntegration() {
  return (
    <Section heading="integrating from Solidity">
      <p className="text-base leading-relaxed text-neutral-800">
        Read the registry directly from your contract. The proxy
        address is the same on every supported chain, so a single
        constant works everywhere your protocol is deployed.
      </p>

      <CodeBlock>{`interface IThatsRekt {
    function attackerReport(address a)
        external view returns (int256 score, uint256 appearances);

    function isVictim(address a) external view returns (bool);
}

contract MyBridge {
    IThatsRekt constant rekt = IThatsRekt(0x0000000000000000000000000000000000000000);

    // Block when 3+ whitelisters have net-confirmed the recipient is
    // an attacker. Higher = more conservative (slower to block, fewer
    // false positives); lower = more aggressive.
    int256 constant ATTACKER_THRESHOLD = 3;

    function withdraw(address recipient, uint256 amount) external {
        (int256 score, ) = rekt.attackerReport(recipient);
        require(score < ATTACKER_THRESHOLD, "recipient flagged as attacker");
        // ... rest of withdraw
    }
}`}</CodeBlock>

      <p className="text-sm leading-relaxed text-neutral-700">
        Replace <Inline>0x000…000</Inline> with the proxy address from
        the <strong>reference</strong> table at the bottom of this
        page. View calls are gas-cheap (~3k) and idempotent — safe to
        call inline in any tx hot path.
      </p>

      <SubSection heading="picking a threshold">
        <Code>attackerScore</Code> is a signed integer. Each post that
        names the address as an attacker contributes <Code>+1</Code>{' '}
        per confirmation and <Code>-1</Code> per disconfirmation. So:
        <ul className="list-disc list-inside mt-2 space-y-1 marker:text-neutral-400">
          <li>
            <strong className="font-black">positive, large</strong> →
            multiple whitelisters agree the address is an attacker.
            Block.
          </li>
          <li>
            <strong className="font-black">near zero</strong> →
            either nobody has flagged this address, or flags have been
            refuted as many times as confirmed. Don't block on score
            alone.
          </li>
          <li>
            <strong className="font-black">negative</strong> → posts
            naming this address as an attacker have been actively
            refuted. Almost certainly safe.
          </li>
        </ul>
        <p className="mt-2">
          The threshold of <Code>3</Code> in the example means "block
          when at least three whitelisters net-confirm." Tune up for
          fewer false positives, down for tighter safety. The second
          return value (<Inline>appearances</Inline>) is also useful
          when you want a confidence floor — e.g. only block when the
          address has been named in 2+ separate posts.
        </p>
      </SubSection>
    </Section>
  )
}

// =============================================================================
// dApp / GraphQL integration
// =============================================================================

function DappIntegration() {
  return (
    <Section heading="integrating from a dApp (GraphQL)">
      <p className="text-base leading-relaxed text-neutral-800">
        For dApps and indexers that don't sit on-chain, query the
        public Mesh GraphQL gateway. It exposes a single endpoint
        that fans out to every chain and sort-merges results
        automatically.
      </p>
      <div className="border-2 border-black bg-neutral-50 px-4 py-3">
        <p className="text-[10px] uppercase tracking-widest text-neutral-700 mb-1">
          [endpoint]
        </p>
        <p className="font-mono text-sm break-all">
          {PUBLIC_GRAPHQL_ENDPOINT}
        </p>
      </div>

      <CodeBlock>{`# fetch the latest 10 posts across all indexed chains
query LatestPosts {
  posts(limit: 10) {
    items {
      id
      chain { slug name }
      poster
      title
      note
      attackedAt
      attackers
      victims
      confirmations
      disconfirmations
      netScore
    }
    totalCount
  }
}`}</CodeBlock>

      <SubSection heading="per-chain queries">
        Per-chain prefixed roots are also available — useful when you
        need the full post-detail view including confirmation log +
        edit history:
      </SubSection>
      <CodeBlock>{`query PostDetail($id: String!) {
  Base_postById(id: $id) {
    id
    title
    note
    poster { id }
    attackedAt
    confirmations
    disconfirmations
    netScore
    attackerLinks { address { id attackerScore } }
    victimLinks { address { id isVictim } }
    confirmationLog(orderBy: blockNumber_ASC) {
      confirmer { id }
      newDirection
      blockNumber
      timestamp
    }
    edits(orderBy: blockNumber_ASC) {
      kind
      newNote
      newTitle
      addedAttackers
      addedVictims
    }
  }
}`}</CodeBlock>

      <p className="text-xs leading-relaxed text-neutral-700">
        Available chain prefixes: <Inline>Base_</Inline>,{' '}
        <Inline>Optimism_</Inline>, <Inline>Sepolia_</Inline>, and so
        on. Full schema introspection is available at the GraphQL
        endpoint.
      </p>
    </Section>
  )
}

// =============================================================================
// Reference
// =============================================================================

/**
 * Chains we plan to support. Each entry is one row in the deployments
 * table. Production contracts will be CREATE2-identical across all of
 * them; until each is live, the proxy column shows "— TBD —" and the
 * status column shows "pending deploy".
 */
const PLANNED_DEPLOYMENTS: ReadonlyArray<{
  name: string
  chainId: number
  proxy: string | null
}> = [
  { name: 'ethereum', chainId: 1, proxy: null },
  { name: 'base', chainId: 8453, proxy: null },
  { name: 'optimism', chainId: 10, proxy: null },
  { name: 'arbitrum', chainId: 42161, proxy: null },
  { name: 'polygon', chainId: 137, proxy: null },
  { name: 'bsc', chainId: 56, proxy: null },
  { name: 'blast', chainId: 81457, proxy: null },
  { name: 'avalanche', chainId: 43114, proxy: null },
] as const

/**
 * Governance multisig — the Safe that proposes + executes on the
 * TimelockController. CREATE2-deterministic; lives at the same address
 * on every chain thatsRekt is deployed to.
 */
const GOVERNANCE_MULTISIG_ADDRESS = '0x59E4DBc95BD312A882Bb36b7f3E8298682340679'

/** Public Mesh GraphQL endpoint — single source of truth, referenced
 *  from both the dApp integration section and the reference table. */
const PUBLIC_GRAPHQL_ENDPOINT = 'https://thatsrekt.com/graphql'

function Reference() {
  return (
    <Section heading="reference">
      <SubSection heading="deployments">
        <p className="text-sm leading-relaxed text-neutral-800 mb-3">
          The proxy address is{' '}
          <strong className="font-black">stable across chains</strong>{' '}
          via CREATE2 — when contracts ship, the same address will
          resolve on every chain below.
        </p>
        <div className="overflow-x-auto border-2 border-black">
          <table className="w-full text-left text-sm">
            <thead className="border-b-2 border-black bg-black/5 text-xs uppercase tracking-widest">
              <tr>
                <th className="px-3 py-2">chain</th>
                <th className="px-3 py-2">chain id</th>
                <th className="px-3 py-2">proxy</th>
                <th className="px-3 py-2">status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black font-mono text-xs">
              {PLANNED_DEPLOYMENTS.map((d) => (
                <tr key={d.name}>
                  <td className="px-3 py-2 font-black">{d.name}</td>
                  <td className="px-3 py-2 tabular-nums">{d.chainId}</td>
                  <td className="px-3 py-2 text-neutral-600 break-all">
                    {d.proxy ?? '— TBD —'}
                  </td>
                  <td className="px-3 py-2 uppercase tracking-widest">
                    {d.proxy ? (
                      <span className="text-emerald-700">live</span>
                    ) : (
                      <span className="text-amber-700">pending deploy</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SubSection>

      <SubSection heading="governance">
        <p className="text-sm leading-relaxed text-neutral-800 mb-3">
          The Safe multisig that proposes + executes on the
          TimelockController. CREATE2-deterministic — the{' '}
          <strong className="font-black">same address on every chain</strong>{' '}
          thatsRekt is deployed to. Every governance call (whitelist
          additions/removals, contract upgrades) flows through the
          7-day delay.
        </p>
        <div className="border-2 border-black bg-neutral-50 px-4 py-3 font-mono text-xs sm:text-sm break-all">
          {GOVERNANCE_MULTISIG_ADDRESS}
        </div>
      </SubSection>

      <SubSection heading="public endpoints">
        <ul className="space-y-2 text-sm">
          <li>
            <strong className="font-black">GraphQL gateway:</strong>{' '}
            <Inline>{PUBLIC_GRAPHQL_ENDPOINT}</Inline>
          </li>
          <li>
            <strong className="font-black">Source:</strong>{' '}
            <a
              href="https://github.com/JeronimoHoulin/thatsRekt"
              target="_blank"
              rel="noopener noreferrer"
              className="rekt-link"
            >
              github.com/JeronimoHoulin/thatsRekt ↗
            </a>
          </li>
        </ul>
      </SubSection>
    </Section>
  )
}

// =============================================================================
// Layout primitives
// =============================================================================

function Section({
  heading,
  children,
}: {
  heading: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-5">
      <h2 className="font-black uppercase tracking-tighter text-2xl sm:text-3xl leading-none">
        {heading}
      </h2>
      {children}
    </section>
  )
}

function SubSection({
  heading,
  children,
}: {
  heading: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-3 pt-1">
      <h3 className="font-black uppercase tracking-widest text-xs">
        {heading}
      </h3>
      {children}
    </div>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto border-2 border-black bg-neutral-50 p-4 text-xs leading-relaxed font-mono">
      <code>{children}</code>
    </pre>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-sm bg-neutral-100 border border-neutral-300 px-1 py-0.5 break-all">
      {children}
    </code>
  )
}

function Inline({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-sm break-all">{children}</code>
}
