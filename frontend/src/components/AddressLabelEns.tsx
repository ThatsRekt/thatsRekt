/**
 * AddressLabelEns — wagmi-dependent ENS-resolving wrapper.
 *
 * THIS FILE IS ONLY IMPORTED VIA React.lazy — never statically. Rollup
 * will therefore place it (and its transitive import of `wagmi`) in the
 * async wagmi chunk, keeping it off the homepage-critical JS path.
 *
 * The WalletRuntime lazy boundary in AddressLabel.tsx ensures this module
 * is only loaded after WagmiProvider is mounted, so `useEnsLookup` can
 * safely call `useEnsName` without throwing "useConfig must be used within
 * WagmiProvider".
 */

import { useEnsLookup } from '../hooks/useEnsLookup'
import { AddressLabelCore, type AddressLabelCoreProps } from './AddressLabelCore'

/**
 * ENS-enhanced AddressLabel. Calls `useEnsLookup` (which calls wagmi's
 * `useEnsName` under the hood) and passes the resolved name to the pure
 * `AddressLabelCore` renderer.
 *
 * Must only be rendered inside a WagmiProvider tree.
 * Loaded as a default export so React.lazy can consume it.
 */
export default function AddressLabelEns(props: AddressLabelCoreProps) {
  const { name: ensName } = useEnsLookup(
    /^0x[0-9a-fA-F]{40}$/.test(props.addr)
      ? (props.addr as `0x${string}`)
      : undefined,
  )

  return <AddressLabelCore {...props} ensName={ensName} />
}
