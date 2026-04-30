import { http, createConfig, fallback } from 'wagmi'
import { base } from 'wagmi/chains'
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
 * wagmi v2 config. Chains: Base only for v1 (the registry is deployed on
 * Base; multi-chain support comes when we deploy to other chains).
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
  chains: [base],
  connectors: [
    injected({ shimDisconnect: true }),
    coinbaseWallet({ appName: 'thatsRekt', appLogoUrl: 'https://thatsrekt.com/favicon.svg' }),
    safe(),
  ],
  transports: {
    [base.id]: baseTransport,
  },
  // SSR: false — this is a Vite SPA, no server-rendered hydration step.
  ssr: false,
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
