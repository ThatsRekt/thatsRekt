import { BecomeAPosterCallout } from "../components/BecomeAPosterCallout";
import { AddressLabel } from "../components/AddressLabel";
import { CopyableText } from "../components/CopyableText";
import { DocsTOC, slugify, type TocEntry } from "../components/DocsTOC";
import { StackDiagram } from "../components/diagrams/StackDiagram";
import { PostLifecycleDiagram } from "../components/diagrams/PostLifecycleDiagram";

/**
 * Single-page docs for integrators. Plain JSX (no MDX, no syntax
 * highlighter) — keeps the bundle lean. Migrate to a proper docs site
 * (Docusaurus / Mintlify / vitepress) when this page outgrows the format.
 *
 * Layout: on lg+ viewports the page bleeds wider than the app's
 * `max-w-3xl` container (via `lg:-mx-32`) to make room for a sticky
 * left-side TOC. On smaller viewports the TOC is hidden — the page is
 * short enough that linear reading + browser anchor links suffice.
 */
const TOC_ENTRIES: ReadonlyArray<TocEntry> = [
  { id: slugify("what is thatsRekt"), label: "what is it" },
  { id: slugify("how posts work"), label: "how posts work" },
  { id: slugify("use cases"), label: "use cases" },
  { id: slugify("architecture"), label: "architecture" },
  { id: slugify("integrating from Solidity"), label: "solidity" },
  { id: slugify("integrating from a dApp (GraphQL)"), label: "graphql" },
  { id: slugify("reference"), label: "reference" },
];

export function Docs() {
  return (
    <div className="lg:flex lg:gap-10 lg:-mx-32 lg:px-6">
      <DocsTOC entries={TOC_ENTRIES} />
      <article className="flex-1 space-y-12 min-w-0">
        <Hero />
        <WhatIs />
        <HowItWorks />
        <BecomeAPosterCallout />
        <UseCases />
        <Architecture />
        <SolidityIntegration />
        <DappIntegration />
        <Reference />
      </article>
    </div>
  );
}

// =============================================================================
// Use cases — concrete user stories
// =============================================================================

function UseCases() {
  return (
    <Section heading="use cases">
      <p className="text-base leading-relaxed text-neutral-800">
        The registry is just data; what makes it useful is integrators wiring it
        into their own decision logic. A few concrete shapes of integration:
      </p>

      <UseCase
        actor="wallet"
        scenario="Pre-flight every outbound tx"
        body={
          <>
            Before signing a transfer or approve, read{" "}
            <Code>attackerScore(recipient)</Code>. If it's above your threshold
            (e.g. ≥ 2 net confirmations), warn the user with a "this address has
            been reported as an attacker" interstitial that requires explicit
            override. Same check works for spending approvals and contract
            interactions.
          </>
        }
      />

      <UseCase
        actor="DEX router"
        scenario="Block swaps tied to flagged pools"
        body={
          <>
            On every swap path, check <Code>isVictim(token)</Code> for input +
            output. If true, the pool's been reported as the target of an active
            attack. Refuse to route through it. Cheap onchain read, no indexer
            dependency.
          </>
        }
      />

      <UseCase
        actor="lending market"
        scenario="Auto-pause your own contracts when reported under attack"
        body={
          <>
            A keeper periodically calls <Code>isVictim(address(this))</Code>:
            when it flips true, trigger your pause guardian. Even if your team
            hasn't woken up yet, peer security teams' alerts pause new borrows
            within seconds of detection.
          </>
        }
      />

      <UseCase
        actor="bridge"
        scenario="Refuse releases to flagged recipients"
        body={
          <>
            Same shape as the wallet check, but applied at the destination chain
            release step. Receiving deposits from a chain currently under
            exploit (or sending to an attacker address) gets blocked before
            funds leave your custody.
          </>
        }
      />

      <UseCase
        actor="risk dashboard"
        scenario="Surface live incidents to ops teams"
        body={
          <>
            Subscribe to <Code>PostCreated</Code> events from the registry on
            every chain you care about. Pipe into PagerDuty / Slack / your
            incident bot. The onchain feed is the same substrate every other
            integrator reads, so your dashboards and your contract guards stay
            in lockstep.
          </>
        }
      />

      <UseCase
        actor="security firm / detector"
        scenario="Report attacks the second your detector fires"
        body={
          <>
            From a whitelisted EOA, call{" "}
            <Code>
              post(expectedPostId, title, attackers, victims, note, attackedAt)
            </Code>{" "}
            the moment your fork-monitor / mempool-scanner / forensic heuristic
            fires. Other guardians see your report and race to confirm or
            refute. Confirmer karma builds reputation over time.
          </>
        }
      />
    </Section>
  );
}

function UseCase({
  actor,
  scenario,
  body,
}: {
  actor: string;
  scenario: string;
  body: React.ReactNode;
}) {
  return (
    <div className="border-2 border-black bg-white p-4 space-y-2">
      <p className="text-[10px] uppercase tracking-widest text-neutral-700">
        [{actor}] · {scenario}
      </p>
      <p className="text-sm leading-relaxed text-neutral-800">{body}</p>
    </div>
  );
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
  );
}

// =============================================================================
// What is thatsRekt
// =============================================================================

function WhatIs() {
  return (
    <Section heading="what is thatsRekt">
      <p className="text-base leading-relaxed text-neutral-800">
        thatsRekt is an{" "}
        <strong className="font-black">onchain hack alert registry</strong>.
        Whitelisted guardians report structured alerts about active onchain
        exploits on any EVM chain: attacker addresses, victim contracts, and a
        free-form note. Other guardians race to <em>vouch</em> (confirm) or{" "}
        <em>refute</em> (disconfirm).
      </p>
      <p className="text-base leading-relaxed text-neutral-800">
        Other contracts read this state directly: a bridge can refuse to release
        funds to a recipient with a high{" "}
        <code className="font-mono text-sm">attackerScore</code>, a wallet can
        warn before sending to a flagged address, a lending market can pause
        when its own contracts are reported under attack. The registry is
        permissioned to write but{" "}
        <strong className="font-black">open to read</strong>: every score,
        attack, and confirmer set is queryable from any contract or app.
      </p>
    </Section>
  );
}

// =============================================================================
// How posts work
// =============================================================================

function HowItWorks() {
  return (
    <Section heading="how posts work">
      <SubSection heading="whitelisters">
        Authorized addresses (the guardians listed under{" "}
        <Inline>/guardians</Inline>). They can call <Code>post(...)</Code>,{" "}
        <Code>confirm(...)</Code>, and <Code>disconfirm(...)</Code>. Each report
        includes a title, attacker addresses, victim contracts, and a free-form
        note. Confirmer identities are public onchain. Addresses reach the
        whitelist through a governance review: an applicant applies, the{" "}
        <strong className="font-black">governance multisig</strong> vets and
        approves them, then submits the address via a{" "}
        <strong className="font-black">3-day timelock</strong>. The onchain
        whitelist is the source of truth.
      </SubSection>
      <SubSection heading="governance">
        Three roles, asymmetric delays: adding guardians is slow and public,
        kicking them out is instant.{" "}
        <strong className="font-black">Removing a misbehaving guardian</strong>{" "}
        is direct multisig action, no delay.{" "}
        <strong className="font-black">Adding a new guardian</strong> goes
        through a separate{" "}
        <strong className="font-black">3-day TimelockController</strong> (long
        enough for integrators to react if the multisig schedules a hostile
        operator, short enough that real-world onboarding doesn't grind).
        Contract upgrades are gated by a{" "}
        <strong className="font-black">7-day TimelockController</strong> on the
        owner role, so integrators always have a week to disengage if a hostile
        upgrade is queued. The multisig can also instantly{" "}
        <Code>revokeWhitelistAdmin()</Code>, a kill-switch that zeros the admin
        slot, blocking new additions until the owner re-installs through the
        7-day path.
      </SubSection>
      <SubSection heading="integrators">
        Anyone reading the registry. Two main signals: an address's{" "}
        <Code>attackerScore</Code> (signed integer: sum of confirmations minus
        disconfirmations across every active attack that names the address as an
        attacker) and an address's <Code>isVictim</Code> flag (true if the
        address is currently the target of an active alert). Both are readable
        onchain in a single view call.
      </SubSection>
    </Section>
  );
}

// =============================================================================
// Architecture
// =============================================================================

function Architecture() {
  return (
    <Section heading="architecture">
      <p className="text-base leading-relaxed text-neutral-800">
        Single Solidity contract per chain, deployed at the same address on
        every supported chain via deterministic CREATE2. One integration
        constant works everywhere your protocol is deployed.
      </p>

      <SubSection heading="the stack at a glance">
        <p className="text-sm leading-relaxed text-neutral-800 mb-2">
          A guardian submits an alert; the contract emits an event; the indexer
          writes it to Postgres; the GraphQL gateway exposes it; this site
          renders it. Reader contracts and dApps tap in at whichever tier
          matches their needs: direct onchain reads (cheap, no infra) or rich
          GraphQL queries (free, public).
        </p>
        <StackDiagram />
      </SubSection>

      <SubSection heading="post lifecycle">
        <p className="text-sm leading-relaxed text-neutral-800 mb-2">
          Each post lives forever in storage and events. Confirmer activity
          updates the aggregate <Code>attackerScore</Code> in real time; readers
          don't need an indexer to consume the score, only a single view call
          against the proxy.
        </p>
        <PostLifecycleDiagram />
      </SubSection>

      <SubSection heading="public read functions">
        <p className="text-sm leading-relaxed text-neutral-800 mb-2">
          Anyone can call these (no whitelist needed). This is what dApps,
          indexers, and onchain integrators consume.
        </p>
        <ul className="space-y-1 text-sm leading-relaxed text-neutral-800 list-disc list-inside marker:text-neutral-400">
          <li>
            <Code>attackerReport(address)</Code> →{" "}
            <Inline>(int256 score, uint256 appearances)</Inline>. Signed score
            from confirmer activity (each <Inline>Up</Inline> +1, each{" "}
            <Inline>Down</Inline> -1 across every active post that names the
            address), plus how many active posts currently list it as an
            attacker. Both decrement when a post is retracted.
          </li>
          <li>
            <Code>isVictim(address)</Code> → <Inline>bool</Inline>. True when
            the address is the target of at least one currently-active alert.
          </li>
          <li>
            <Code>getPost(uint256 id)</Code> → full post struct (poster,
            attackedAt, title, note, attackers, victims, confirmations,
            disconfirmations, removed).
          </li>
          <li>
            <Code>recentActivePosts(uint256 limit)</Code> → array of recent post
            ids that haven't been retracted.
          </li>
          <li>
            <Code>activePostsBefore(uint256 beforeId, uint256 limit)</Code> →
            cursor-paginated walk through active history.
          </li>
          <li>
            <Code>getConfirmers(uint256 postId)</Code> /{" "}
            <Code>getDisconfirmers(uint256 postId)</Code> → confirmer sets per
            direction.
          </li>
          <li>
            <Code>getConfirmerCount(uint256 postId)</Code> /{" "}
            <Code>getDisconfirmerCount(uint256 postId)</Code> → cheap counts
            when you don't need the full set.
          </li>
        </ul>
      </SubSection>

      <SubSection heading="whitelisted write functions">
        <p className="text-sm leading-relaxed text-neutral-800 mb-2">
          Only addresses on the whitelist can call these. They're what guardians
          use to submit and curate alerts.
        </p>
        <ul className="space-y-1 text-sm leading-relaxed text-neutral-800 list-disc list-inside marker:text-neutral-400">
          <li>
            <Code>
              post(expectedPostId, title, attackers, victims, note, attackedAt)
            </Code>{" "}
            → submit a new alert. Returns the new post id.
          </li>
          <li>
            <Code>confirm(postId, direction)</Code> → vouch (<Inline>Up</Inline>
            ) or refute (<Inline>Down</Inline>) an existing post. One vote per
            address per post; calling again switches direction.
          </li>
          <li>
            <Code>unconfirm(postId)</Code> → withdraw your existing confirmation
            or disconfirmation.
          </li>
          <li>
            <Code>retract(postId)</Code> → pull your own post (only the original
            poster can retract).
          </li>
          <li>
            <Code>amendNote(postId, newNote)</Code> /{" "}
            <Code>amendTitle(postId, newTitle)</Code> → edit your own post's
            note or title.
          </li>
          <li>
            <Code>addAttackers(postId, addrs)</Code> /{" "}
            <Code>addVictims(postId, addrs)</Code> → append addresses to your
            own post (no removal; the audit trail is append-only).
          </li>
        </ul>
      </SubSection>

      <SubSection heading="cross-chain identity">
        Guardians are EOAs whitelisted independently per chain. The same address
        can report on every chain because CREATE2 makes the proxy address
        identical everywhere. The leaderboard aggregates a guardian's lifetime
        activity across chains by address.
      </SubSection>

      <SubSection heading="off-chain pipeline (optional)">
        For whitelisted operators running automated detectors that can't sign
        transactions themselves, the <Inline>relay/</Inline> service in the
        monorepo provides a webhook-driven submission path. Single-tenant: bring
        your own EOA + bearer token. See{" "}
        <a
          href="https://github.com/ThatsRekt/thatsRekt/blob/master/relay/README.md"
          target="_blank"
          rel="noopener noreferrer"
          className="rekt-link"
        >
          relay/README.md ↗
        </a>{" "}
        for the full spec.
      </SubSection>
    </Section>
  );
}

// =============================================================================
// Solidity integration
// =============================================================================

function SolidityIntegration() {
  return (
    <Section heading="integrating from Solidity">
      <p className="text-base leading-relaxed text-neutral-800">
        Read the registry directly from your contract. The proxy address is the
        same on every supported chain, so a single constant works everywhere
        your protocol is deployed.
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
        Replace <Inline>0x000…000</Inline> with the proxy address from the{" "}
        <strong>reference</strong> table at the bottom of this page. View calls
        are gas-cheap (~3k) and idempotent, safe to call inline in any tx hot
        path.
      </p>

      <SubSection heading="picking a threshold">
        <Code>attackerScore</Code> is a signed integer. Each post that names the
        address as an attacker contributes <Code>+1</Code> per confirmation and{" "}
        <Code>-1</Code> per disconfirmation. So:
        <ul className="list-disc list-inside mt-2 space-y-1 marker:text-neutral-400">
          <li>
            <strong className="font-black">positive, large</strong> → multiple
            whitelisters agree the address is an attacker. Block.
          </li>
          <li>
            <strong className="font-black">near zero</strong> → either nobody
            has flagged this address, or flags have been refuted as many times
            as confirmed. Don't block on score alone.
          </li>
          <li>
            <strong className="font-black">negative</strong> → posts naming this
            address as an attacker have been actively refuted. Almost certainly
            safe.
          </li>
        </ul>
        <p className="mt-2">
          The threshold of <Code>3</Code> in the example means "block when at
          least three whitelisters net-confirm." Tune up for fewer false
          positives, down for tighter safety. The second return value (
          <Inline>appearances</Inline>) is also useful when you want a
          confidence floor (e.g. only block when the address has been named in
          2+ separate posts).
        </p>
      </SubSection>
    </Section>
  );
}

// =============================================================================
// dApp / GraphQL integration
// =============================================================================

function DappIntegration() {
  return (
    <Section heading="integrating from a dApp (GraphQL)">
      <p className="text-base leading-relaxed text-neutral-800">
        For dApps and indexers that don't sit onchain, query the public Mesh
        GraphQL gateway. It exposes a single endpoint that fans out to every
        chain and sort-merges results automatically.
      </p>
      <CopyableText label="[endpoint]" value={PUBLIC_GRAPHQL_ENDPOINT} />

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
        Per-chain prefixed roots are also available, useful when you need the
        full post-detail view including confirmation log + edit history:
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
        Available chain prefixes: <Inline>Base_</Inline>,{" "}
        <Inline>Sepolia_</Inline>, and so on. Full schema introspection is
        available at the GraphQL endpoint.
      </p>
    </Section>
  );
}

// =============================================================================
// Reference
// =============================================================================

/**
 * Chains we plan to support. Each entry is one row in the deployments
 * table. Production contracts are CREATE2-identical across every chain
 * with the same governance + initial whitelisters — pending deploys
 * resolve to the canonical proxy address.
 *
 * Base mainnet went live with v1.1.0 (caller-supplied `expectedPostId`,
 * EIP-712 comments off-chain, cross-canceller TLC role split) on
 * 2026-05-02 at the address shown below. Old v1.0.0 proxy
 * (`0x390f7b…865936`) is abandoned.
 */
const PLANNED_DEPLOYMENTS: ReadonlyArray<{
  name: string;
  chainId: number;
  proxy: string | null;
  status?: "live" | "redeploying";
}> = [
  {
    name: "ethereum",
    chainId: 1,
    proxy: "0xBfaEEE9662b4c037De24e5Caa65815350d57b89A",
    status: "live",
  },
  {
    name: "base",
    chainId: 8453,
    proxy: "0xBfaEEE9662b4c037De24e5Caa65815350d57b89A",
    status: "live",
  },
  {
    name: "optimism",
    chainId: 10,
    proxy: "0xBfaEEE9662b4c037De24e5Caa65815350d57b89A",
    status: "live",
  },
  {
    name: "arbitrum",
    chainId: 42161,
    proxy: "0xBfaEEE9662b4c037De24e5Caa65815350d57b89A",
    status: "live",
  },
  {
    name: "polygon",
    chainId: 137,
    proxy: "0xBfaEEE9662b4c037De24e5Caa65815350d57b89A",
    status: "live",
  },
  {
    name: "bsc",
    chainId: 56,
    proxy: "0xBfaEEE9662b4c037De24e5Caa65815350d57b89A",
    status: "live",
  },
] as const;

/**
 * Governance multisig — the Safe that proposes + executes on the
 * TimelockController. CREATE2-deterministic; lives at the same address
 * on every chain thatsRekt is deployed to.
 */
const GOVERNANCE_MULTISIG_ADDRESS =
  "0x59E4DBc95BD312A882Bb36b7f3E8298682340679";

/** Public Mesh GraphQL endpoint — single source of truth, referenced
 *  from both the dApp integration section and the reference table. */
const PUBLIC_GRAPHQL_ENDPOINT = "https://thatsrekt.com/graphql";

const CHAIN_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  ethereum: "Ethereum",
  base: "Base",
  optimism: "Optimism",
  arbitrum: "Arbitrum",
  polygon: "Polygon",
  bsc: "BSC",
};

function Reference() {
  const liveChains = PLANNED_DEPLOYMENTS.filter((d) => d.status === "live");
  const liveChainNames = liveChains.map(
    (d) =>
      CHAIN_DISPLAY_NAMES[d.name] ??
      d.name.charAt(0).toUpperCase() + d.name.slice(1),
  );
  const liveChainList =
    liveChainNames.length === 0
      ? ""
      : liveChainNames.length === 1
        ? liveChainNames[0]
        : liveChainNames.slice(0, -1).join(", ") +
          ", and " +
          liveChainNames[liveChainNames.length - 1];

  return (
    <Section heading="reference">
      <SubSection heading="deployments">
        <p className="text-sm leading-relaxed text-neutral-800 mb-3">
          The proxy address is{" "}
          <strong className="font-black">stable across chains</strong> via
          CREATE2: when contracts ship with the canonical governance +
          whitelist, the same address resolves onchain on every live chain
          below. {liveChainList} {liveChainNames.length === 1 ? "is" : "are"}{" "}
          all live at the canonical proxy.
        </p>
        <div className="overflow-x-auto border-2 border-black">
          <table className="w-full text-left text-sm">
            <thead className="border-b-2 border-black bg-black/5 text-xs uppercase tracking-widest">
              <tr>
                <th className="px-3 py-2">chain</th>
                <th className="px-3 py-2">chain id</th>
                <th className="px-3 py-2">proxy (poster.thatsRekt.eth)</th>
                <th className="px-3 py-2">status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black font-mono text-xs">
              {PLANNED_DEPLOYMENTS.map((d) => (
                <tr key={d.name}>
                  <td className="px-3 py-2 font-black">{d.name}</td>
                  <td className="px-3 py-2 tabular-nums">{d.chainId}</td>
                  <td className="px-3 py-2 text-neutral-600 break-all">
                    {d.proxy ? (
                      <AddressLabel addr={d.proxy} chainSlug={d.name} full />
                    ) : (
                      "TBD"
                    )}
                  </td>
                  <td className="px-3 py-2 uppercase tracking-widest">
                    {d.status === "live" ? (
                      <span className="text-emerald-700">live</span>
                    ) : d.status === "redeploying" ? (
                      <span className="text-sky-700">redeploying</span>
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
          One Safe multisig governs every chain (same address on all of them via
          CREATE2). Three roles, asymmetric delays: guardians are{" "}
          <strong className="font-black">removed instantly</strong>{" "}
          (incident-response is fast), but{" "}
          <strong className="font-black">added on a 3-day timelock</strong>{" "}
          (operator rotation is publicly visible before it lands). Contract
          upgrades sit on a separate{" "}
          <strong className="font-black">7-day timelock</strong>, giving
          integrators a week to disengage if a hostile upgrade is queued.
        </p>
        <div className="border-2 border-black bg-neutral-50 px-3 sm:px-4 py-3">
          <p className="text-[10px] uppercase tracking-widest text-neutral-700 mb-1">
            [governance multisig]
          </p>
          <AddressLabel
            addr={GOVERNANCE_MULTISIG_ADDRESS}
            chainSlug="ethereum"
            full
          />
        </div>
      </SubSection>

      <SubSection heading="public endpoints">
        <CopyableText
          label="[graphql gateway]"
          value={PUBLIC_GRAPHQL_ENDPOINT}
        />
        <p className="text-sm pt-2">
          <strong className="font-black">Source:</strong>{" "}
          <a
            href="https://github.com/ThatsRekt/thatsRekt"
            target="_blank"
            rel="noopener noreferrer"
            className="rekt-link"
          >
            github.com/ThatsRekt/thatsRekt ↗
          </a>
        </p>
      </SubSection>
    </Section>
  );
}

// =============================================================================
// Layout primitives
// =============================================================================

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  // Auto-derive an id from the heading so the TOC + browser hash links
  // resolve without each call site having to repeat itself. `slugify` is
  // shared with `DocsTOC` so the two stay in lockstep.
  const id = slugify(heading);
  return (
    <section className="space-y-5" id={id}>
      <h2 className="font-black uppercase tracking-tighter text-2xl sm:text-3xl leading-none scroll-mt-6">
        {heading}
      </h2>
      {children}
    </section>
  );
}

function SubSection({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4 pt-1">
      <h3 className="font-black uppercase tracking-widest text-xs">
        {heading}
      </h3>
      {children}
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto border-2 border-black bg-neutral-50 p-4 text-xs leading-relaxed font-mono">
      <code>{children}</code>
    </pre>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-sm bg-neutral-100 border border-neutral-300 px-1 py-0.5 break-all">
      {children}
    </code>
  );
}

function Inline({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-sm break-all">{children}</code>;
}
