import { http, createConfig, fallback } from 'wagmi'
import { arbitrum, base, baseSepolia, mainnet, optimism } from 'wagmi/chains'
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
 * Base Sepolia transport — used for the purge-capable contract under test.
 * Public Base Sepolia RPC (no auth required for reads / wallet-funded
 * writes). Wrapped in `fallback` for the same reason as `baseTransport`.
 */
const baseSepoliaTransport = fallback([
  http('https://sepolia.base.org'),
])

/**
 * Optimism mainnet transport — registry is deployed here at the same
 * canonical address as Base mainnet (cross-chain CREATE2). Same fallback
 * shape as `baseTransport`.
 */
const optimismTransport = fallback([
  http('https://lb.routeme.sh/rpc/10/3bd2e340-f97c-46b3-80ed-17975de5af89'),
  http('https://mainnet.optimism.io'),
])

/**
 * Ethereum mainnet transport — registry is deployed here (v1.2.0
 * canonical proxy at 0xBfaEEE…b89A) AND used for ENS reverse resolution.
 * ENS primary names live on mainnet regardless of which chain the address
 * is active on, so any displayed address's ENS lookup always hits Ethereum.
 */
const mainnetTransport = fallback([
  http('https://lb.routeme.sh/rpc/1/3bd2e340-f97c-46b3-80ed-17975de5af89'),
  http('https://eth.llamarpc.com'),
])

/**
 * Arbitrum One transport — registry is deployed here at the same
 * canonical cross-chain CREATE2 address as the other v1.2.0 chains.
 */
const arbitrumTransport = fallback([
  http('https://lb.routeme.sh/rpc/42161/3bd2e340-f97c-46b3-80ed-17975de5af89'),
  http('https://arb1.arbitrum.io/rpc'),
])

/**
 * wagmi v2 config.
 *
 * Chains (v1.2.0 — registry deployed at canonical 0xBfaEEE…b89A on all 4 mainnets):
 *   - `mainnet`      — registry deployed here; also used for ENS reverse resolution.
 *   - `base`         — registry deployed here.
 *   - `arbitrum`     — registry deployed here.
 *   - `optimism`     — registry deployed here.
 *   - `baseSepolia`  — testnet registry (separate dev-salt deploy).
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
  chains: [mainnet, base, arbitrum, optimism, baseSepolia],
  connectors: [
    injected({ shimDisconnect: true }),
    coinbaseWallet({ appName: 'thatsRekt', appLogoUrl: 'https://thatsrekt.com/favicon.svg' }),
    safe(),
  ],
  transports: {
    [mainnet.id]: mainnetTransport,
    [base.id]: baseTransport,
    [arbitrum.id]: arbitrumTransport,
    [optimism.id]: optimismTransport,
    [baseSepolia.id]: baseSepoliaTransport,
  },
  // SSR: false — this is a Vite SPA, no server-rendered hydration step.
  ssr: false,
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
