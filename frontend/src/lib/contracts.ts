/**
 * On-chain registry contract handles.
 *
 * Per-chain proxy registry. CREATE2-deterministic per (governance, whitelist,
 * purgeAdmin, initialWhitelisters) tuple. v1.1.0 fresh deploy: caller-
 * supplied `expectedPostId` on `post()`, EIP-712 comments off-chain,
 * cross-canceller TLC role split, full purge surface. Old v1.0.0 proxies
 * are abandoned (no migration, no integrators relied on them).
 *
 * Typed as a literal-keyed record (not `Record<number, ...>`) so wagmi's
 * `chainId` field — which narrows to the configured chain literal union —
 * accepts the keys we pass back via `chainsWithRegistry()` without a cast.
 */
export const REGISTRY_PROXIES = {
  // Base mainnet — v1.1.0 deploy 2026-05-02. Block 45476762.
  // Cross-canceller geometry:
  //   - GOVERNANCE_OWNER  = bauti.eth EOA (proposes upgrade + add TLCs)
  //   - WHITELIST_OPERATOR = cold wallet (cancels upgrade + add TLCs;
  //                          instant whitelist kill-switch)
  //   - PURGE_REMOVER_EOA  = cold wallet (proposes purge TLC; instant
  //                          purge kill-switch)
  // 6 initial whitelisters: cold, bauti, jerry, aux, jerry-bot, DAMM hot.
  8453: '0x585192Be5805Dc6D2F326369E6D0F8B7E11a7974',
  // Base Sepolia — v1.1.0 dev deploy 2026-05-02. Block 40987178.
  // Same role geometry as Base mainnet.
  84532: '0x5278dD25e8551Cc98f2dC89791f5C89a9C83F695',
  // Optimism mainnet — v1.1.0 deploy 2026-05-02. Same role geometry +
  // identical INITIAL_WHITELISTERS as Base mainnet, so CREATE2 lands
  // the proxy at the cross-chain canonical address.
  10: '0x585192Be5805Dc6D2F326369E6D0F8B7E11a7974',
} as const satisfies Record<number, `0x${string}`>

/** Chain IDs that have a deployed registry. Literal-narrowed for wagmi. */
export type SupportedChainId = keyof typeof REGISTRY_PROXIES

export const registryAddress = (
  chainId: number,
): `0x${string}` | undefined =>
  (REGISTRY_PROXIES as Record<number, `0x${string}`>)[chainId]

/** Chain IDs with a deployed registry, in display order. */
export const chainsWithRegistry = (): readonly SupportedChainId[] =>
  [8453, 84532] as const

/**
 * @deprecated Use `registryAddress(chainId)` instead. This still resolves to
 * Base's proxy for back-compat — the existing vote/whitelist hooks are
 * Base-pinned and will be migrated to multi-chain in a follow-up.
 */
export const REGISTRY_PROXY_ADDRESS = REGISTRY_PROXIES[8453]

/**
 * On-chain `ConfirmDirection` enum mirror.
 *
 * Solidity's `enum ConfirmDirection { None, Up, Down }` encodes as `uint8`
 * over the wire. The names are surfaced for callers that want to reason
 * about votes by intent ("did the user vote Up?") rather than by raw
 * integer. Keep the numeric values aligned with the contract — these are
 * the values we send into `confirm()` and read back from
 * `confirmationOf()`.
 */
export const ConfirmDirection = {
  None: 0,
  Up: 1,
  Down: 2,
} as const

export type ConfirmDirectionValue =
  (typeof ConfirmDirection)[keyof typeof ConfirmDirection]

/**
 * Minimal ABI — only the surfaces the frontend currently calls. Keeping
 * this trimmed (vs importing the full impl ABI) keeps the bundle small
 * and the TypeScript inference fast. Add functions here as the
 * frontend grows to call them.
 */
export const registryAbi = [
  {
    type: 'function',
    name: 'isWhitelisted',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  // Public mapping getter — returns this address's vote on a given post:
  //   0 = None (no vote / cleared), 1 = Up, 2 = Down.
  {
    type: 'function',
    name: 'confirmationOf',
    stateMutability: 'view',
    inputs: [
      { name: '', type: 'uint256' },
      { name: '', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint8' }],
  },
  // Cast (or change) a vote on a post. Reverts unless caller is whitelisted.
  // `direction` MUST be Up or Down — passing None reverts with
  // `InvalidConfirmDirection()` on-chain. To clear a vote, call `unconfirm`.
  {
    type: 'function',
    name: 'confirm',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'postId', type: 'uint256' },
      { name: 'direction', type: 'uint8' },
    ],
    outputs: [],
  },
  // Clear an existing vote. Reverts with `NothingToUnconfirm()` when the
  // caller never voted on this post. Whitelisted-only.
  {
    type: 'function',
    name: 'unconfirm',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'postId', type: 'uint256' }],
    outputs: [],
  },
  // Total post count — public state var auto-getter. Useful for caches /
  // "any posts yet" checks without hammering the indexer.
  {
    type: 'function',
    name: 'postCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Submit a new alert with optimistic id commitment. Reverts unless
  // the caller is whitelisted AND the next assigned id matches the
  // caller's `expectedPostId` claim.
  //   expectedPostId  — caller's claim of the next post id; must equal
  //                     postCount + 1 or the call reverts
  //                     `PostIdMismatch(expected, actual)`. Read it via
  //                     `peekNextPostId()` immediately before signing so
  //                     pre-published share URLs land at the asserted id.
  //   title           — required, 1..200 bytes
  //   attackers_      — addresses suspected of perpetrating the attack
  //   victims_        — addresses that lost funds
  //   note            — free-form description
  //   attackedAt      — unix seconds, > 0, <= block.timestamp
  {
    type: 'function',
    name: 'post',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'expectedPostId', type: 'uint256' },
      { name: 'title', type: 'string' },
      { name: 'attackers_', type: 'address[]' },
      { name: 'victims_', type: 'address[]' },
      { name: 'note', type: 'string' },
      { name: 'attackedAt', type: 'uint64' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
  },
  // Convenience view: id the next successful `post()` will receive
  // (i.e. `postCount + 1`). Frontend calls this to populate
  // `expectedPostId` immediately before broadcasting a post tx.
  {
    type: 'function',
    name: 'peekNextPostId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const
