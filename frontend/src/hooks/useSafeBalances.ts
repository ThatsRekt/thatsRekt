import { useQuery } from '@tanstack/react-query'

const SAFE_ADDRESS = '0x59E4DBc95BD312A882Bb36b7f3E8298682340679'
const SAFE_API = `https://safe-transaction-mainnet.safe.global/api/v1/safes/${SAFE_ADDRESS}/balances/`

// Hardcoded prices — no RPC calls. ETH/WETH at $2,500, stablecoins at $1.
// Add new tokens here via PR when new assets appear in the Safe.
const TOKEN_PRICES: Record<string, { priceUsd: number; symbol: string; decimals: number }> = {
  native: { priceUsd: 2_500, symbol: 'ETH', decimals: 18 },
  // USDC
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': { priceUsd: 1, symbol: 'USDC', decimals: 6 },
  // WETH
  '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': { priceUsd: 2_500, symbol: 'WETH', decimals: 18 },
}

interface SafeApiBalance {
  tokenAddress: string | null
  token: {
    name: string
    symbol: string
    decimals: number
    logoUri: string
  } | null
  balance: string
}

export interface TokenBalance {
  symbol: string
  balance: number
  usdValue: number
  isKnown: boolean
  tokenAddress: string | null
  logoUri?: string
}

export const ETH_PRICE_USD = TOKEN_PRICES['native'].priceUsd

async function fetchSafeBalances(): Promise<{ tokens: TokenBalance[]; totalUsd: number }> {
  const res = await fetch(SAFE_API)
  if (!res.ok) throw new Error(`Safe API error: ${res.status}`)
  const data: SafeApiBalance[] = await res.json()

  const tokens: TokenBalance[] = data
    .map((item): TokenBalance => {
      const key = item.tokenAddress ?? 'native'
      const known = TOKEN_PRICES[key]
      const decimals = known?.decimals ?? item.token?.decimals ?? 18
      const balance = Number(item.balance) / Math.pow(10, decimals)

      if (known) {
        return {
          symbol: known.symbol,
          balance,
          usdValue: balance * known.priceUsd,
          isKnown: true,
          tokenAddress: item.tokenAddress,
          logoUri: item.token?.logoUri,
        }
      }

      return {
        symbol: item.token?.symbol ?? '???',
        balance,
        usdValue: 0,
        isKnown: false,
        tokenAddress: item.tokenAddress,
        logoUri: item.token?.logoUri,
      }
    })
    .filter((t) => t.balance > 0)

  const totalUsd = tokens.reduce((sum, t) => sum + t.usdValue, 0)
  return { tokens, totalUsd }
}

export function useSafeBalances() {
  return useQuery({
    queryKey: ['safe-balances'],
    queryFn: fetchSafeBalances,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  })
}
