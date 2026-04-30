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
        Other contracts read this state directly: a DEX router can
        block a swap when the recipient's{' '}
        <code className="font-mono text-sm">attackerScore</code> is too
        negative, a wallet can warn the user, a stablecoin can
        circuit-break. The registry is permissioned to write but{' '}
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
        Single Solidity contract per chain. UUPS-upgradeable proxy
        owned by a TimelockController; the timelock owner is a Safe
        multisig. The same proxy address exists on every supported
        chain via deterministic CREATE2 deploys, so a single
        integration constant works cross-chain.
      </p>

      <SubSection heading="components">
        <ul className="space-y-1 text-sm leading-relaxed text-neutral-800 list-disc list-inside">
          <li>
            <strong className="font-black">ThatsRekt</strong> — UUPS
            implementation. Holds posts, attackers, victims,
            confirmation log, and the whitelist.
          </li>
          <li>
            <strong className="font-black">ERC1967Proxy</strong> —
            stable storage front. Calls forward to whichever
            implementation the proxy currently points at.
          </li>
          <li>
            <strong className="font-black">TimelockController</strong>{' '}
            — proxy admin. Every governance call (whitelist
            mgmt, upgrade) is queued for 7 days before it can execute.
          </li>
          <li>
            <strong className="font-black">Safe multisig</strong> —
            timelock proposer + executor. The actual humans / signing
            policy.
          </li>
        </ul>
      </SubSection>

      <SubSection heading="permission model">
        <ul className="space-y-1 text-sm leading-relaxed text-neutral-800 list-disc list-inside">
          <li>
            <strong className="font-black">owner</strong> (timelock):
            can <Code>addWhitelisted</Code> /{' '}
            <Code>removeWhitelisted</Code>, <Code>upgradeTo</Code>.
            All gated by the 7-day delay.
          </li>
          <li>
            <strong className="font-black">whitelisted</strong>: can{' '}
            <Code>post</Code>, <Code>confirm</Code>,{' '}
            <Code>disconfirm</Code>, <Code>retract</Code>,{' '}
            <Code>amendNote</Code>, <Code>addAttackers</Code>,{' '}
            <Code>addVictims</Code>.
          </li>
          <li>
            <strong className="font-black">public</strong>: every view
            function. <Code>attackerReport(addr)</Code>,{' '}
            <Code>isVictim(addr)</Code>,{' '}
            <Code>recentActivePosts(n)</Code>,{' '}
            <Code>getPost(id)</Code>, etc.
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

contract MySwapRouter {
    IThatsRekt constant rekt = IThatsRekt(0x0000000000000000000000000000000000000000);
    int256 constant ATTACKER_THRESHOLD = -3;

    function swap(address recipient, ...) external {
        (int256 score, ) = rekt.attackerReport(recipient);
        require(score > ATTACKER_THRESHOLD, "recipient flagged");
        // ... rest of swap
    }
}`}</CodeBlock>

      <p className="text-sm leading-relaxed text-neutral-700">
        Replace <Inline>0x000…000</Inline> with the proxy address from
        the <strong>reference</strong> table at the bottom of this
        page. View calls are gas-cheap (~3k) and idempotent — safe to
        call inline in any tx hot path.
      </p>

      <SubSection heading="picking a threshold">
        <Code>attackerScore</Code> is a signed int. Positive means net
        confirmations — multiple whitelisters have agreed the address
        is an attacker. Each post the address appears in contributes
        ±1 per confirmation/disconfirmation. A threshold of{' '}
        <Code>-3</Code> in the example above means: only block when at
        least three whitelisters disagree about the address being
        flagged. Tune to your risk tolerance.
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
 * TimelockController. Set this once the production multisig is
 * deployed; until then it shows as TBD on the docs page.
 */
const GOVERNANCE_MULTISIG: { address: string | null; chain: string } = {
  address: null,
  chain: 'ethereum',
}

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
          The multisig that proposes + executes on the
          TimelockController. Owner of every deployed proxy
          (governance is centralized at one address; the timelock
          enforces the 7-day delay on every change).
        </p>
        <div className="overflow-x-auto border-2 border-black">
          <table className="w-full text-left text-sm">
            <thead className="border-b-2 border-black bg-black/5 text-xs uppercase tracking-widest">
              <tr>
                <th className="px-3 py-2">role</th>
                <th className="px-3 py-2">chain</th>
                <th className="px-3 py-2">address</th>
                <th className="px-3 py-2">status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black font-mono text-xs">
              <tr>
                <td className="px-3 py-2 font-black">governance multisig</td>
                <td className="px-3 py-2">{GOVERNANCE_MULTISIG.chain}</td>
                <td className="px-3 py-2 text-neutral-600 break-all">
                  {GOVERNANCE_MULTISIG.address ?? '— TBD —'}
                </td>
                <td className="px-3 py-2 uppercase tracking-widest">
                  {GOVERNANCE_MULTISIG.address ? (
                    <span className="text-emerald-700">live</span>
                  ) : (
                    <span className="text-amber-700">pending deploy</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </SubSection>

      <SubSection heading="public endpoints">
        <ul className="space-y-2 text-sm">
          <li>
            <strong className="font-black">GraphQL gateway:</strong>{' '}
            <Inline>https://thatsrekt.com/graphql</Inline>
          </li>
          <li>
            <strong className="font-black">Frontend:</strong>{' '}
            <Inline>https://thatsrekt.com</Inline>
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
