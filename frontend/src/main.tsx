import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { WalletBoundary } from './wallet/WalletBoundary'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('No root element found')

/**
 * Provider order matters: WalletBoundary lazy-mounts WagmiProvider after
 * first paint. WagmiProvider MUST be inside QueryClientProvider because it
 * uses TanStack Query under the hood for read-contract caching.
 *
 * The WalletBoundary wraps the entire App so that all wagmi-hook consumers
 * (ConfirmVoteButtons, CommentThread, PostAlertButton, AccountChip) are
 * inside the WagmiProvider tree. WalletRuntime (the lazy chunk) loads the
 * wagmi config + connectors + viem transports AFTER the browser has painted
 * the Suspense fallback — keeping those ~150-200 KB gzip OFF the
 * homepage-critical JS path.
 *
 * Suspense fallback: null. The app shell renders quickly via BrowserRouter
 * (the routing + layout is baked into App) but the entire App is inside the
 * lazy boundary, so first visible paint is the browser's native loading
 * state while both the wagmi chunk and the feed data fetch are in-flight.
 * In practice the wagmi chunk arrives in <200ms on a warm CDN edge, and the
 * GraphQL feed query is also ~200-500ms, so users see the feed and the
 * wallet buttons arrive together.
 *
 * BrowserRouter must sit INSIDE QueryClientProvider + WalletBoundary so that
 * route-based data hooks and wagmi hooks can all access their respective
 * contexts from within route components.
 *
 * See: https://thatsrekt.com nginx.conf for the `/post/*` SSR OG card route
 * that requires pathname routing (not hash routing).
 */
createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WalletBoundary
        walletSlot={
          <BrowserRouter>
            <App />
          </BrowserRouter>
        }
      />
    </QueryClientProvider>
  </StrictMode>,
)
