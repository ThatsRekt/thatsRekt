import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { App } from './App'
import { wagmiConfig } from './lib/wagmi'
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

// Provider order matters: Wagmi must be inside QueryClientProvider (it
// uses TanStack Query under the hood for read-contract caching).
createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WagmiProvider config={wagmiConfig}>
        <HashRouter>
          <App />
        </HashRouter>
      </WagmiProvider>
    </QueryClientProvider>
  </StrictMode>,
)
