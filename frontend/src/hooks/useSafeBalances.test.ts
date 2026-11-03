import { afterEach, expect, test } from 'bun:test'
import { fetchSafeBalances } from './useSafeBalances'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

test('orders tokens by USD value, highest first, unpriced last', async () => {
  const token = (symbol: string, decimals: number) => ({ name: symbol, symbol, decimals, logoUri: '' })
  globalThis.fetch = (async () =>
    Response.json([
      { tokenAddress: null, token: null, balance: '10000000000000000' }, // 0.01 ETH = $20
      { tokenAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', token: token('WETH', 18), balance: '80000000000000000' }, // $160
      { tokenAddress: '0x000000000000000000000000000000000000dEaD', token: token('SPAM', 18), balance: '5000000000000000000000' },
      { tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', token: token('USDC', 6), balance: '287000000' }, // $287
      { tokenAddress: '0xdC035D45d973E3EC169d2276DDab16f1e407384F', token: token('USDS', 18), balance: '1000000000000000000000' }, // $1,000
    ])) as unknown as typeof fetch

  const { tokens, totalUsd } = await fetchSafeBalances()
  expect(tokens.map((t) => t.symbol)).toEqual(['USDS', 'USDC', 'ETH', 'SPAM'])
  expect(totalUsd).toBe(1467)
})
