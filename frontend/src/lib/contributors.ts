/**
 * Human-readable labels for whitelisted contributor addresses.
 *
 * Keyed by lowercase address. The whitelist itself is on-chain (the
 * indexer's Whitelister entity is the source of truth for who CAN post);
 * this file only attaches names so the UI can display "SlowMist" instead
 * of "0x1234…abcd".
 *
 * Adding a contributor:
 *   1. The address must be added on-chain via governance
 *      (`addWhitelisted(address)` through the timelock). Once indexed,
 *      it shows up in the contributors list automatically with its
 *      raw address as the label.
 *   2. To attach a name, add an entry below.
 *
 * Per-chain mapping leaves room for the same address to be labeled
 * differently per chain (rare, but possible if an org delegates to
 * different sub-orgs per chain). When unspecified, falls back to
 * `unknownChain` lookup.
 */

export interface ContributorLabel {
  /** Display name. */
  readonly name: string
  /** Optional one-line tagline shown next to the name. */
  readonly tagline?: string
  /** Optional homepage URL. */
  readonly url?: string
  /**
   * Optional X (Twitter) handle — `@` prefix optional, full URLs also fine.
   * Resolved to `https://x.com/<handle>` at render time.
   */
  readonly twitter?: string
  /**
   * Optional GitHub username — full URLs also fine. Resolved to
   * `https://github.com/<handle>` at render time.
   */
  readonly github?: string
}

/** Per-chain overrides. */
type PerChainLabels = Partial<Record<string, Record<string, ContributorLabel>>>

/** Address → label, when no chain-specific override exists. */
type GlobalLabels = Record<string, ContributorLabel>

const GLOBAL: GlobalLabels = {
  // Anvil default account 0 — only used in local dev seeds. Hidden from
  // prod by the chain registry's `isLocalFork` filter; safe to keep here
  // for clarity in dev contributors view.
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266': {
    name: 'Dev EOA (Anvil account 0)',
    tagline: 'local-dev seeder — never authoritative on real chains',
  },
}

const PER_CHAIN: PerChainLabels = {
  // anvil-eth: { '0x...': { name: '...' } },
  // sepolia:   { '0x...': { name: '...' } },
  // base:      { '0x...': { name: '...' } },
}

/**
 * Resolve a label for an address, checking per-chain overrides first,
 * then global. Returns undefined if no label is registered — caller
 * should fall back to the address itself.
 */
export function lookupContributor(
  chainSlug: string,
  address: string,
): ContributorLabel | undefined {
  const lc = address.toLowerCase()
  return PER_CHAIN[chainSlug]?.[lc] ?? GLOBAL[lc]
}
