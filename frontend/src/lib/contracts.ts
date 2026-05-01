/**
 * On-chain registry contract handles.
 *
 * Per-chain proxy registry. CREATE2-deterministic per (governance, whitelist,
 * purgeAdmin) triple. Base only for now — Optimism is being temporarily
 * deprecated while the new purge-capable contract stabilises; older OP archive
 * entries are still resolvable via the chain registry in `chains.ts`.
 *
 * Typed as a literal-keyed record (not `Record<number, ...>`) so wagmi's
 * `chainId` field — which narrows to the configured chain literal union —
 * accepts the keys we pass back via `chainsWithRegistry()` without a cast.
 */
export const REGISTRY_PROXIES = {
  // Base mainnet — this is the *legacy* proxy without purgeAdmin. The
  // new purge-capable contract is being tested on Base Sepolia first;
  // when that lands, we'll fresh-deploy on Base mainnet at a new
  // address and swap this entry. Until then, prod runs against the
  // legacy contract so the feed/voting/posting all still work.
  8453: '0x390f7b37545CaD278dD3DADC92a20b9f45865936',
} as const satisfies Record<number, `0x${string}`>

/** Chain IDs that have a deployed registry. Literal-narrowed for wagmi. */
export type SupportedChainId = keyof typeof REGISTRY_PROXIES

export const registryAddress = (
  chainId: number,
): `0x${string}` | undefined =>
  (REGISTRY_PROXIES as Record<number, `0x${string}`>)[chainId]

/** Chain IDs with a deployed registry, in display order (Base only for now). */
export const chainsWithRegistry = (): readonly SupportedChainId[] =>
  [8453] as const

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
  // Submit a new alert. Reverts unless caller is whitelisted.
  //   title       — required, 1..200 bytes
  //   attackers_  — addresses suspected of perpetrating the attack
  //   victims_    — addresses that lost funds
  //   note        — free-form description
  //   attackedAt  — unix seconds, > 0, <= block.timestamp
  {
    type: 'function',
    name: 'post',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'title', type: 'string' },
      { name: 'attackers_', type: 'address[]' },
      { name: 'victims_', type: 'address[]' },
      { name: 'note', type: 'string' },
      { name: 'attackedAt', type: 'uint64' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
  },
] as const
