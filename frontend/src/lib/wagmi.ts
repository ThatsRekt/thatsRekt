import { http, createConfig, fallback } from 'wagmi'
import { base, mainnet, optimism } from 'wagmi/chains'
import { injected, coinbaseWallet, safe } from 'wagmi/connectors'

/**
 * Public read RPC for Base mainnet. Used for the wagmi public client (chain
 * state reads — `isWhitelisted`, etc.). The user's wallet provides its own
 * RPC for writes once connected.
 *
 * Wrapped in a `fallback` transport so a single RPC blip doesn't take the
 * gate down — `routeme.sh` is primary, public Base endpoint is the
 * fallback. Both no-key for browser-side reads.
 */
const baseTransport = fallback([
  http('https://lb.routeme.sh/rpc/8453/3bd2e340-f97c-46b3-80ed-17975de5af89'),
  http('https://mainnet.base.org'),
])

/**
 * Public read RPC for Optimism mainnet. Same role as `baseTransport` —
 * powers the wagmi public client for chain state reads on OP. Wallet RPC
 * takes over for writes once connected.
 *
 * `routeme.sh` is primary, the public OP endpoint is the fallback. Both
 * no-key for browser-side reads.
 */
const optimismTransport = fallback([
  http('https://lb.routeme.sh/rpc/10/3bd2e340-f97c-46b3-80ed-17975de5af89'),
  http('https://mainnet.optimism.io'),
])

/**
 * Ethereum mainnet transport — *only* used for ENS reverse resolution.
 * ENS primary names live on mainnet regardless of which chain the address
 * is active on, so even though our registry is on Base, ENS lookups for
 * any displayed address always hit Ethereum. wagmi's `useEnsName` picks
 * up this transport automatically when called with `chainId: mainnet.id`.
 */
const mainnetTransport = fallback([
  http('https://lb.routeme.sh/rpc/1/3bd2e340-f97c-46b3-80ed-17975de5af89'),
  http('https://eth.llamarpc.com'),
])

/**
 * wagmi v2 config.
 *
 * Chains:
 *   - `base`     — registry is deployed here; reads/writes for the contract.
 *   - `optimism` — registry is also deployed here (different whitelist set
 *                  → different CREATE2 proxy address); reads/writes.
 *   - `mainnet`  — ENS reverse resolution only; we don't connect wallets here.
 *
 * Connectors:
 *   - `injected()`     — covers MetaMask, Rabby, Brave Wallet, Frame, Trust browser extension, etc.
 *   - `coinbaseWallet()` — Coinbase Smart Wallet popup + Coinbase Wallet ext (no project id required).
 *   - `safe()`         — auto-connects when this dApp is loaded inside a Safe Wallet app iframe.
 *
 * NOT included yet: WalletConnect (mobile QR + 200+ wallets). Adding it
 * requires a Reown / WalletConnect Cloud project id; once we have one, drop
 * `walletConnect({ projectId })` into the connectors array and it just works.
 */
export const wagmiConfig = createConfig({
  chains: [base, optimism, mainnet],
  connectors: [
    injected({ shimDisconnect: true }),
    coinbaseWallet({ appName: 'thatsRekt', appLogoUrl: 'https://thatsrekt.com/favicon.svg' }),
    safe(),
  ],
  transports: {
    [base.id]: baseTransport,
    [optimism.id]: optimismTransport,
    [mainnet.id]: mainnetTransport,
  },
  // SSR: false — this is a Vite SPA, no server-rendered hydration step.
  ssr: false,
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
