/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GRAPHQL_ENDPOINT?: string
  readonly VITE_PUBLIC_RPC_ETHEREUM_URL?: string
  readonly VITE_PUBLIC_RPC_BASE_URL?: string
  readonly VITE_PUBLIC_RPC_ARBITRUM_URL?: string
  readonly VITE_PUBLIC_RPC_OPTIMISM_URL?: string
  readonly VITE_PUBLIC_RPC_BSC_URL?: string
  readonly VITE_PUBLIC_RPC_POLYGON_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
