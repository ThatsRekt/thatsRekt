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
] as const
