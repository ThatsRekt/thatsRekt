/**
 * On-chain registry contract handles.
 *
 * Cross-chain identical-address deploy: the same proxy address resolves
 * on every chain we deploy to (CREATE2 deterministic). Today only Base
 * is live; future chains drop in here.
 */
export const REGISTRY_PROXY_ADDRESS =
  '0x390f7b37545CaD278dD3DADC92a20b9f45865936' as const

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
] as const
