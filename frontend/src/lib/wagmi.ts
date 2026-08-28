import { http, createConfig } from 'wagmi'
import { arbitrum, base, baseSepolia, bsc, mainnet, optimism, polygon } from 'wagmi/chains'
import { injected, coinbaseWallet, safe } from 'wagmi/connectors'
import { loadPublicRpcUrls } from './publicRpc'

const PUBLIC_RPC_URLS = loadPublicRpcUrls()

const baseTransport = http(PUBLIC_RPC_URLS.base)

/**
 * Base Sepolia is an explicit non-production testnet transport. Production
 * chains use only their required public configuration variables above.
 */
const baseSepoliaTransport = http('https://sepolia.base.org')

const optimismTransport = http(PUBLIC_RPC_URLS.optimism)
const mainnetTransport = http(PUBLIC_RPC_URLS.ethereum)
const arbitrumTransport = http(PUBLIC_RPC_URLS.arbitrum)
const bscTransport = http(PUBLIC_RPC_URLS.bsc)
const polygonTransport = http(PUBLIC_RPC_URLS.polygon)

/**
 * wagmi v2 config.
 *
 * Chains (v1.2.0 — registry deployed at canonical 0xBfaEEE…b89A on all 6 mainnets):
 *   - `mainnet`      — registry deployed here; also used for ENS reverse resolution.
 *   - `base`         — registry deployed here.
 *   - `arbitrum`     — registry deployed here.
 *   - `optimism`     — registry deployed here.
 *   - `bsc`          — registry deployed here.
 *   - `polygon`      — registry deployed here.
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
  chains: [mainnet, base, arbitrum, optimism, bsc, polygon, baseSepolia],
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
    [bsc.id]: bscTransport,
    [polygon.id]: polygonTransport,
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
