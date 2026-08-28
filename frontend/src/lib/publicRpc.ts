export const PUBLIC_RPC_ENVIRONMENT_VARIABLES = [
  'VITE_PUBLIC_RPC_ETHEREUM_URL',
  'VITE_PUBLIC_RPC_BASE_URL',
  'VITE_PUBLIC_RPC_ARBITRUM_URL',
  'VITE_PUBLIC_RPC_OPTIMISM_URL',
  'VITE_PUBLIC_RPC_BSC_URL',
  'VITE_PUBLIC_RPC_POLYGON_URL',
] as const

export type PublicRpcEnvironmentVariable =
  (typeof PUBLIC_RPC_ENVIRONMENT_VARIABLES)[number]

export type PublicRpcChain =
  | 'ethereum'
  | 'base'
  | 'arbitrum'
  | 'optimism'
  | 'bsc'
  | 'polygon'

export type PublicRpcEnvironment = Readonly<
  Record<string, string | boolean | undefined>
>

export type PublicRpcUrls = Readonly<Record<PublicRpcChain, string>>

const VARIABLE_BY_CHAIN: Readonly<
  Record<PublicRpcChain, PublicRpcEnvironmentVariable>
> = {
  ethereum: 'VITE_PUBLIC_RPC_ETHEREUM_URL',
  base: 'VITE_PUBLIC_RPC_BASE_URL',
  arbitrum: 'VITE_PUBLIC_RPC_ARBITRUM_URL',
  optimism: 'VITE_PUBLIC_RPC_OPTIMISM_URL',
  bsc: 'VITE_PUBLIC_RPC_BSC_URL',
  polygon: 'VITE_PUBLIC_RPC_POLYGON_URL',
}

export class PublicRpcConfigurationError extends Error {
  constructor(variableName: PublicRpcEnvironmentVariable) {
    super(`Invalid required public RPC environment variable: ${variableName}`)
    this.name = 'PublicRpcConfigurationError'
  }
}

const parsePublicRpcUrl = ({
  value,
  variableName,
}: {
  readonly value: string | boolean | undefined
  readonly variableName: PublicRpcEnvironmentVariable
}): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PublicRpcConfigurationError(variableName)
  }

  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      throw new PublicRpcConfigurationError(variableName)
    }
    return url.toString()
  } catch (error) {
    if (error instanceof PublicRpcConfigurationError) throw error
    throw new PublicRpcConfigurationError(variableName)
  }
}

export const resolvePublicRpcUrls = (
  environment: PublicRpcEnvironment,
): PublicRpcUrls => ({
  ethereum: parsePublicRpcUrl({
    value: environment[VARIABLE_BY_CHAIN.ethereum],
    variableName: VARIABLE_BY_CHAIN.ethereum,
  }),
  base: parsePublicRpcUrl({
    value: environment[VARIABLE_BY_CHAIN.base],
    variableName: VARIABLE_BY_CHAIN.base,
  }),
  arbitrum: parsePublicRpcUrl({
    value: environment[VARIABLE_BY_CHAIN.arbitrum],
    variableName: VARIABLE_BY_CHAIN.arbitrum,
  }),
  optimism: parsePublicRpcUrl({
    value: environment[VARIABLE_BY_CHAIN.optimism],
    variableName: VARIABLE_BY_CHAIN.optimism,
  }),
  bsc: parsePublicRpcUrl({
    value: environment[VARIABLE_BY_CHAIN.bsc],
    variableName: VARIABLE_BY_CHAIN.bsc,
  }),
  polygon: parsePublicRpcUrl({
    value: environment[VARIABLE_BY_CHAIN.polygon],
    variableName: VARIABLE_BY_CHAIN.polygon,
  }),
})

export const loadPublicRpcUrls = (): PublicRpcUrls =>
  resolvePublicRpcUrls(import.meta.env)
