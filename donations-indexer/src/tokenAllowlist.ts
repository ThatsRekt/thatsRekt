/**
 * Token allowlist for the donations indexer.
 *
 * Slice #205: Ethereum only, native ETH only.
 * Slice #207: Ethereum ERC20 allowlist added (~9 major tokens).
 * Slice #209: Base, Arbitrum, Optimism, BSC, Polygon added.
 *
 * Design:
 * - Pure module — no I/O, no side effects. Testable in total isolation.
 * - `nativeFloor(chainId)` filters 1-wei spam; returns 0n for unknown chains
 *   (fail-open on unfamiliar chains — the processor validates chain before
 *   calling, so returning 0n for unknown is safe).
 * - `isAllowed(chainId, tokenAddress)` returns true for the native sentinel
 *   (null/undefined/'') and for any whitelisted ERC20. Returns false for
 *   unknown chains or unknown tokens.
 * - `tokenMeta(chainId, tokenAddress)` returns symbol + decimals for allowed
 *   tokens. Returns null for unknown tokens (processor skips them).
 * - `erc20Addresses(chainId)` returns all allowlisted ERC20 addresses (lowercased)
 *   for a given chain — used by the processor to register addLog subscriptions.
 *
 * The native sentinel is represented as null (tokenAddress === null).
 * ERC20 entries are lowercased addresses.
 *
 * ERC20 decimals/symbols were verified on-chain via cast call before being
 * committed here. See PR body for the exact cast commands and results.
 *
 * Transfer(address,address,uint256) topic0:
 *   keccak256("Transfer(address,address,uint256)")
 *   = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
 * Pre-computed and exported as TRANSFER_TOPIC0 to avoid runtime hashing.
 */

export interface TokenMeta {
  readonly symbol: string
  readonly decimals: number
}

export interface ChainAllowlist {
  /** Native coin entry. */
  readonly native: TokenMeta
  /** Dust floor in native base units (wei). Transfers below this are dropped. */
  readonly nativeFloorWei: bigint
  /** ERC20 allowlist: lowercased address -> meta. */
  readonly erc20: Readonly<Record<string, TokenMeta>>
}

/**
 * ERC-20 Transfer event topic0.
 * keccak256("Transfer(address,address,uint256)")
 * Verified with: cast keccak "Transfer(address,address,uint256)"
 */
export const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// ---------------------------------------------------------------------------
// Ethereum mainnet (chainId 1)
//
// All ERC20 decimals/symbols verified on-chain (Ethereum mainnet, block latest)
// via:
//   cast call <address> "decimals()(uint8)" --rpc-url <routeme-eth>
//   cast call <address> "symbol()(string)"  --rpc-url <routeme-eth>
// See PR #207 body for the exact commands and raw outputs.
//
// Token          | Address                                    | decimals | symbol
// ---------------|--------------------------------------------|----------|-------
// USDC           | 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 |    6     | USDC
// USDT           | 0xdac17f958d2ee523a2206206994597c13d831ec7 |    6     | USDT
// DAI            | 0x6b175474e89094c44da98b954eedeac495271d0f |   18     | DAI
// WETH           | 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2 |   18     | WETH
// WBTC           | 0x2260fac5e5542a773aa44fbcfedf7c193bc2c599 |    8     | WBTC
// stETH (Lido)   | 0xae7ab96520de3a18e5e111b5eaab095312d7fe84 |   18     | stETH
// wstETH (Lido)  | 0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0 |   18     | wstETH
// LINK           | 0x514910771af9ca656af840dff83e8264ecf986ca |   18     | LINK
// AAVE           | 0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9 |   18     | AAVE
// ---------------------------------------------------------------------------

const ETHEREUM_ERC20: Readonly<Record<string, TokenMeta>> = Object.freeze({
  // USDC — 6 decimals (verified on-chain)
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': Object.freeze({ symbol: 'USDC', decimals: 6 }),
  // USDT — 6 decimals (verified on-chain)
  '0xdac17f958d2ee523a2206206994597c13d831ec7': Object.freeze({ symbol: 'USDT', decimals: 6 }),
  // DAI — 18 decimals (verified on-chain)
  '0x6b175474e89094c44da98b954eedeac495271d0f': Object.freeze({ symbol: 'DAI', decimals: 18 }),
  // WETH — 18 decimals (verified on-chain)
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': Object.freeze({ symbol: 'WETH', decimals: 18 }),
  // WBTC — 8 decimals (verified on-chain; NOT 18 — same category of gotcha as syrupUSDC)
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': Object.freeze({ symbol: 'WBTC', decimals: 8 }),
  // stETH (Lido) — 18 decimals (verified on-chain)
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': Object.freeze({ symbol: 'stETH', decimals: 18 }),
  // wstETH (Lido wrapped stETH) — 18 decimals (verified on-chain)
  '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': Object.freeze({ symbol: 'wstETH', decimals: 18 }),
  // LINK (Chainlink) — 18 decimals (verified on-chain)
  '0x514910771af9ca656af840dff83e8264ecf986ca': Object.freeze({ symbol: 'LINK', decimals: 18 }),
  // AAVE — 18 decimals (verified on-chain)
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': Object.freeze({ symbol: 'AAVE', decimals: 18 }),
})

// ---------------------------------------------------------------------------
// Base (chainId 8453)
//
// All ERC20 decimals/symbols verified on-chain (Base mainnet, block latest)
// via:
//   cast call <address> "decimals()(uint8)" --rpc-url https://lb.routeme.sh/rpc/8453/...
//   cast call <address> "symbol()(string)"  --rpc-url https://lb.routeme.sh/rpc/8453/...
// See PR #209 body for the exact commands and raw outputs.
//
// Token   | Address                                    | decimals | symbol
// --------|--------------------------------------------|----------|-------
// USDC    | 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 |    6     | USDC
// USDbC   | 0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca |    6     | USDbC
// WETH    | 0x4200000000000000000000000000000000000006 |   18     | WETH
// DAI     | 0x50c5725949a6f0c72e6c4a641f24049a917db0cb |   18     | DAI
// cbETH   | 0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22 |   18     | cbETH
// wstETH  | 0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452 |   18     | wstETH
// LINK    | 0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196 |   18     | LINK
// cbBTC   | 0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf |    8     | cbBTC
// rETH    | 0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c |   18     | rETH
//
// Note: AAVE token has no deployed contract on Base (eth_getCode = 0x at all
// known addresses). Slot replaced by rETH (Rocket Pool LST, verified above).
// ---------------------------------------------------------------------------

const BASE_ERC20: Readonly<Record<string, TokenMeta>> = Object.freeze({
  // USDC (native Circle USDC on Base) — 6 decimals (verified on-chain)
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': Object.freeze({ symbol: 'USDC', decimals: 6 }),
  // USDbC (Coinbase bridged USDC) — 6 decimals (verified on-chain)
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': Object.freeze({ symbol: 'USDbC', decimals: 6 }),
  // WETH (OP-stack canonical WETH) — 18 decimals (verified on-chain)
  '0x4200000000000000000000000000000000000006': Object.freeze({ symbol: 'WETH', decimals: 18 }),
  // DAI — 18 decimals (verified on-chain)
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': Object.freeze({ symbol: 'DAI', decimals: 18 }),
  // cbETH (Coinbase staked ETH) — 18 decimals (verified on-chain)
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': Object.freeze({ symbol: 'cbETH', decimals: 18 }),
  // wstETH (Lido wstETH bridged to Base) — 18 decimals (verified on-chain)
  '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': Object.freeze({ symbol: 'wstETH', decimals: 18 }),
  // LINK (Chainlink on Base) — 18 decimals (verified on-chain)
  '0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196': Object.freeze({ symbol: 'LINK', decimals: 18 }),
  // cbBTC (Coinbase wrapped BTC) — 8 decimals (verified on-chain; NOT 18)
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': Object.freeze({ symbol: 'cbBTC', decimals: 8 }),
  // rETH (Rocket Pool staked ETH on Base) — 18 decimals (verified on-chain)
  '0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c': Object.freeze({ symbol: 'rETH', decimals: 18 }),
})

// ---------------------------------------------------------------------------
// Arbitrum One (chainId 42161)
//
// All ERC20 decimals/symbols verified on-chain (Arbitrum mainnet, block latest)
// via:
//   cast call <address> "decimals()(uint8)" --rpc-url https://lb.routeme.sh/rpc/42161/...
//   cast call <address> "symbol()(string)"  --rpc-url https://lb.routeme.sh/rpc/42161/...
// See PR #209 body for the exact commands and raw outputs.
//
// Token   | Address                                    | decimals | symbol (onchain)
// --------|--------------------------------------------|----------|------------------
// USDC    | 0xaf88d065e77c8cc2239327c5edb3a432268e5831 |    6     | USDC
// USDC.e  | 0xff970a61a04b1ca14834a43f5de4533ebddb5cc8 |    6     | USDC
// USDT    | 0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9 |    6     | USD&#x20ae;0 (bridged)
// WETH    | 0x82af49447d8a07e3bd95bd0d56f35241523fbab1 |   18     | WETH
// WBTC    | 0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f |    8     | WBTC
// ARB     | 0x912ce59144191c1204e64559fe8253a0e49e6548 |   18     | ARB
// wstETH  | 0x5979d7b546e38e414f7e9822514be443a4800529 |   18     | wstETH
// LINK    | 0xf97f4df75117a78c1a5a0dbb814af92458539fb4 |   18     | LINK
// AAVE    | 0xba5ddd1f9d7f570dc94a51479a000e3bce967196 |   18     | AAVE
//
// Note: USDT on Arbitrum has onchain symbol "USD+T0" (Tether bridged via the
// Arbitrum canonical bridge). Stored as 'USDT' for human readability.
// USDC.e (0xff97...) is legacy bridged USDC; native Circle USDC is 0xaf88...
// Both included. WBTC is 8 decimals (same as Ethereum, NOT 18 like BSC BTCB).
// ---------------------------------------------------------------------------

const ARBITRUM_ERC20: Readonly<Record<string, TokenMeta>> = Object.freeze({
  // USDC (native Circle USDC on Arbitrum) — 6 decimals (verified on-chain)
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': Object.freeze({ symbol: 'USDC', decimals: 6 }),
  // USDC.e (legacy bridged USDC) — 6 decimals (verified on-chain)
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': Object.freeze({ symbol: 'USDC.e', decimals: 6 }),
  // USDT (bridged, onchain symbol "USD+T0") — 6 decimals (verified on-chain; NOT 18)
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': Object.freeze({ symbol: 'USDT', decimals: 6 }),
  // WETH — 18 decimals (verified on-chain)
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': Object.freeze({ symbol: 'WETH', decimals: 18 }),
  // WBTC — 8 decimals (verified on-chain; NOT 18)
  '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': Object.freeze({ symbol: 'WBTC', decimals: 8 }),
  // ARB (Arbitrum governance token) — 18 decimals (verified on-chain)
  '0x912ce59144191c1204e64559fe8253a0e49e6548': Object.freeze({ symbol: 'ARB', decimals: 18 }),
  // wstETH — 18 decimals (verified on-chain)
  '0x5979d7b546e38e414f7e9822514be443a4800529': Object.freeze({ symbol: 'wstETH', decimals: 18 }),
  // LINK — 18 decimals (verified on-chain)
  '0xf97f4df75117a78c1a5a0dbb814af92458539fb4': Object.freeze({ symbol: 'LINK', decimals: 18 }),
  // AAVE — 18 decimals (verified on-chain)
  '0xba5ddd1f9d7f570dc94a51479a000e3bce967196': Object.freeze({ symbol: 'AAVE', decimals: 18 }),
})

// ---------------------------------------------------------------------------
// Optimism (chainId 10)
//
// All ERC20 decimals/symbols verified on-chain (Optimism mainnet, block latest)
// via:
//   cast call <address> "decimals()(uint8)" --rpc-url https://lb.routeme.sh/rpc/10/...
//   cast call <address> "symbol()(string)"  --rpc-url https://lb.routeme.sh/rpc/10/...
// See PR #209 body for the exact commands and raw outputs.
//
// Token   | Address                                    | decimals | symbol
// --------|--------------------------------------------|----------|-------
// USDC    | 0x0b2c639c533813f4aa9d7837caf62653d097ff85 |    6     | USDC
// USDT    | 0x94b008aa00579c1307b0ef2c499ad98a8ce58e58 |    6     | USDT
// WETH    | 0x4200000000000000000000000000000000000006 |   18     | WETH
// DAI     | 0xda10009cbd5d07dd0cecc66161fc93d7c9000da1 |   18     | DAI
// wstETH  | 0x1f32b1c2345538c0c6f582fcb022739c4a194ebb |   18     | wstETH
// OP      | 0x4200000000000000000000000000000000000042 |   18     | OP
// LINK    | 0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6 |   18     | LINK
// AAVE    | 0x76fb31fb4af56892a25e32cfc43de717950c9278 |   18     | AAVE
// WBTC    | 0x68f180fcce6836688e9084f035309e29bf0a2095 |    8     | WBTC
// ---------------------------------------------------------------------------

const OPTIMISM_ERC20: Readonly<Record<string, TokenMeta>> = Object.freeze({
  // USDC (native Circle USDC on Optimism) — 6 decimals (verified on-chain)
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': Object.freeze({ symbol: 'USDC', decimals: 6 }),
  // USDT — 6 decimals (verified on-chain)
  '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': Object.freeze({ symbol: 'USDT', decimals: 6 }),
  // WETH (OP-stack canonical WETH) — 18 decimals (verified on-chain)
  '0x4200000000000000000000000000000000000006': Object.freeze({ symbol: 'WETH', decimals: 18 }),
  // DAI — 18 decimals (verified on-chain)
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': Object.freeze({ symbol: 'DAI', decimals: 18 }),
  // wstETH — 18 decimals (verified on-chain)
  '0x1f32b1c2345538c0c6f582fcb022739c4a194ebb': Object.freeze({ symbol: 'wstETH', decimals: 18 }),
  // OP (Optimism governance token) — 18 decimals (verified on-chain)
  '0x4200000000000000000000000000000000000042': Object.freeze({ symbol: 'OP', decimals: 18 }),
  // LINK — 18 decimals (verified on-chain)
  '0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6': Object.freeze({ symbol: 'LINK', decimals: 18 }),
  // AAVE — 18 decimals (verified on-chain)
  '0x76fb31fb4af56892a25e32cfc43de717950c9278': Object.freeze({ symbol: 'AAVE', decimals: 18 }),
  // WBTC — 8 decimals (verified on-chain; NOT 18)
  '0x68f180fcce6836688e9084f035309e29bf0a2095': Object.freeze({ symbol: 'WBTC', decimals: 8 }),
})

// ---------------------------------------------------------------------------
// BSC (Binance Smart Chain, chainId 56)
//
// All ERC20 decimals/symbols verified on-chain (BSC mainnet, block latest)
// via:
//   cast call <address> "decimals()(uint8)" --rpc-url https://lb.routeme.sh/rpc/56/...
//   cast call <address> "symbol()(string)"  --rpc-url https://lb.routeme.sh/rpc/56/...
// See PR #209 body for the exact commands and raw outputs.
//
// Token | Address                                    | decimals | symbol
// ------|--------------------------------------------|----------|-------
// USDC  | 0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d |   18     | USDC
// USDT  | 0x55d398326f99059ff775485246999027b3197955 |   18     | USDT
// WBNB  | 0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c |   18     | WBNB
// DAI   | 0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3 |   18     | DAI
// ETH   | 0x2170ed0880ac9a755fd29b2688956bd959f933f8 |   18     | ETH
// BTCB  | 0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c |   18     | BTCB
// LINK  | 0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd |   18     | LINK
// AAVE  | 0xfb6115445bff7b52feb98650c87f44907e58f802 |   18     | AAVE
// CAKE  | 0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82 |   18     | Cake
//
// CRITICAL: BSC USDC and USDT are both 18 decimals — Binance-pegged BEP20
// versions, NOT the 6-decimal Circle USDC or Tether ERC20. Verified on-chain.
// Similarly BTCB is 18 decimals (NOT 8 like Ethereum WBTC). Do not copy
// Ethereum decimals to BSC.
// ---------------------------------------------------------------------------

const BSC_ERC20: Readonly<Record<string, TokenMeta>> = Object.freeze({
  // USDC BEP20 (Binance-pegged) — 18 decimals (verified on-chain; NOT 6)
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': Object.freeze({ symbol: 'USDC', decimals: 18 }),
  // USDT BEP20 (Binance-pegged) — 18 decimals (verified on-chain; NOT 6)
  '0x55d398326f99059ff775485246999027b3197955': Object.freeze({ symbol: 'USDT', decimals: 18 }),
  // WBNB (wrapped BNB) — 18 decimals (verified on-chain)
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': Object.freeze({ symbol: 'WBNB', decimals: 18 }),
  // DAI — 18 decimals (verified on-chain)
  '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': Object.freeze({ symbol: 'DAI', decimals: 18 }),
  // ETH (Binance-pegged Ether BEP20) — 18 decimals (verified on-chain)
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8': Object.freeze({ symbol: 'ETH', decimals: 18 }),
  // BTCB (Binance-pegged Bitcoin BEP20) — 18 decimals (verified on-chain; NOT 8 like WBTC)
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': Object.freeze({ symbol: 'BTCB', decimals: 18 }),
  // LINK — 18 decimals (verified on-chain)
  '0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd': Object.freeze({ symbol: 'LINK', decimals: 18 }),
  // AAVE — 18 decimals (verified on-chain)
  '0xfb6115445bff7b52feb98650c87f44907e58f802': Object.freeze({ symbol: 'AAVE', decimals: 18 }),
  // CAKE (PancakeSwap governance token) — 18 decimals (verified on-chain)
  '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': Object.freeze({ symbol: 'CAKE', decimals: 18 }),
})

// ---------------------------------------------------------------------------
// Polygon (chainId 137)
//
// All ERC20 decimals/symbols verified on-chain (Polygon mainnet, block latest)
// via:
//   cast call <address> "decimals()(uint8)" --rpc-url https://lb.routeme.sh/rpc/137/...
//   cast call <address> "symbol()(string)"  --rpc-url https://lb.routeme.sh/rpc/137/...
// See PR #209 body for the exact commands and raw outputs.
//
// Token   | Address                                    | decimals | symbol (onchain)
// --------|--------------------------------------------|----------|------------------
// USDC    | 0x3c499c542cef5e3811e1192ce70d8cc03d5c3359 |    6     | USDC
// USDT    | 0xc2132d05d31c914a87c6611c10748aeb04b58e8f |    6     | USDT0 (onchain)
// WETH    | 0x7ceb23fd6bc0add59e62ac25578270cff1b9f619 |   18     | WETH
// DAI     | 0x8f3cf7ad23cd3cadbd9735aff958023239c6a063 |   18     | DAI
// WBTC    | 0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6 |    8     | WBTC
// WPOL    | 0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270 |   18     | WPOL
// LINK    | 0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39 |   18     | LINK
// AAVE    | 0xd6df932a45c0f255f85145f286ea0b292b21c90b |   18     | AAVE
// MaticX  | 0xfa68fb4628dff1028cfec22b4162fccd0d45efb6 |   18     | MaticX
//
// Note: USDT on Polygon has onchain symbol "USDT0" (Tether Polygon bridge).
// Stored as 'USDT' for human readability. WBTC is 8 decimals (same as
// Ethereum, NOT 18 like BSC BTCB). USDC is native Circle USDC (6 decimals).
// ---------------------------------------------------------------------------

const POLYGON_ERC20: Readonly<Record<string, TokenMeta>> = Object.freeze({
  // USDC (native Circle USDC on Polygon) — 6 decimals (verified on-chain)
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': Object.freeze({ symbol: 'USDC', decimals: 6 }),
  // USDT (Polygon bridge, onchain symbol "USDT0") — 6 decimals (verified on-chain)
  '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': Object.freeze({ symbol: 'USDT', decimals: 6 }),
  // WETH — 18 decimals (verified on-chain)
  '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': Object.freeze({ symbol: 'WETH', decimals: 18 }),
  // DAI — 18 decimals (verified on-chain)
  '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': Object.freeze({ symbol: 'DAI', decimals: 18 }),
  // WBTC — 8 decimals (verified on-chain; NOT 18)
  '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': Object.freeze({ symbol: 'WBTC', decimals: 8 }),
  // WPOL (wrapped POL, formerly WMATIC) — 18 decimals (verified on-chain)
  '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': Object.freeze({ symbol: 'WPOL', decimals: 18 }),
  // LINK — 18 decimals (verified on-chain)
  '0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39': Object.freeze({ symbol: 'LINK', decimals: 18 }),
  // AAVE — 18 decimals (verified on-chain)
  '0xd6df932a45c0f255f85145f286ea0b292b21c90b': Object.freeze({ symbol: 'AAVE', decimals: 18 }),
  // MaticX (Stader staked MATIC/POL) — 18 decimals (verified on-chain)
  '0xfa68fb4628dff1028cfec22b4162fccd0d45efb6': Object.freeze({ symbol: 'MaticX', decimals: 18 }),
})

// ---------------------------------------------------------------------------
// Allowlist registry keyed by EIP-155 chain id.
// Chains absent from this map are not indexed by the donations processor.
// ---------------------------------------------------------------------------

const ALLOWLISTS: Readonly<Record<number, ChainAllowlist>> = Object.freeze({
  // Ethereum mainnet
  1: Object.freeze({
    native: Object.freeze({ symbol: 'ETH', decimals: 18 }),
    // 0.0001 ETH = 100_000_000_000_000 wei. Filters 1-wei spam while still
    // allowing any meaningful micro-donation.
    nativeFloorWei: 100_000_000_000_000n,
    erc20: ETHEREUM_ERC20,
  }),

  // Base
  8453: Object.freeze({
    native: Object.freeze({ symbol: 'ETH', decimals: 18 }),
    // 0.0001 ETH dust floor — same as Ethereum (ETH is native on Base).
    nativeFloorWei: 100_000_000_000_000n,
    erc20: BASE_ERC20,
  }),

  // Arbitrum One
  42161: Object.freeze({
    native: Object.freeze({ symbol: 'ETH', decimals: 18 }),
    // 0.0001 ETH dust floor.
    nativeFloorWei: 100_000_000_000_000n,
    erc20: ARBITRUM_ERC20,
  }),

  // Optimism
  10: Object.freeze({
    native: Object.freeze({ symbol: 'ETH', decimals: 18 }),
    // 0.0001 ETH dust floor.
    nativeFloorWei: 100_000_000_000_000n,
    erc20: OPTIMISM_ERC20,
  }),

  // BSC — native BNB
  56: Object.freeze({
    native: Object.freeze({ symbol: 'BNB', decimals: 18 }),
    // 0.001 BNB dust floor (BNB ~$600; 0.001 BNB ~$0.60 — meaningful signal).
    nativeFloorWei: 1_000_000_000_000_000n,
    erc20: BSC_ERC20,
  }),

  // Polygon — native POL (formerly MATIC)
  137: Object.freeze({
    native: Object.freeze({ symbol: 'POL', decimals: 18 }),
    // 1 POL dust floor (POL ~$0.20; 1 POL is a reasonable floor).
    nativeFloorWei: 1_000_000_000_000_000_000n,
    erc20: POLYGON_ERC20,
  }),
})

/** Return the allowlist for a chain, or null if the chain is not indexed. */
export const allowlistFor = (chainId: number): ChainAllowlist | null =>
  ALLOWLISTS[chainId] ?? null

/**
 * Is `tokenAddress` allowlisted on `chainId`?
 * `tokenAddress` is null for native-coin transfers.
 */
export const isAllowed = (chainId: number, tokenAddress: string | null): boolean => {
  const list = allowlistFor(chainId)
  if (!list) return false
  if (tokenAddress === null) return true
  return Object.prototype.hasOwnProperty.call(list.erc20, tokenAddress.toLowerCase())
}

/**
 * Return the native dust floor (in wei) for a chain.
 * Returns 0n for unknown chains (fail-open; caller validates chain before use).
 */
export const nativeFloor = (chainId: number): bigint =>
  allowlistFor(chainId)?.nativeFloorWei ?? 0n

/**
 * Return token metadata for an allowlisted token.
 * `tokenAddress` is null for the native coin.
 * Returns null for unknown chains or tokens (caller skips the transfer).
 */
export const tokenMeta = (chainId: number, tokenAddress: string | null): TokenMeta | null => {
  const list = allowlistFor(chainId)
  if (!list) return null
  if (tokenAddress === null) return list.native
  return list.erc20[tokenAddress.toLowerCase()] ?? null
}

/**
 * Return all allowlisted ERC20 addresses (lowercased) for a chain.
 * Returns empty array for unknown chains.
 * Used by the processor to register addLog subscriptions.
 */
export const erc20Addresses = (chainId: number): readonly string[] => {
  const list = allowlistFor(chainId)
  if (!list) return []
  return Object.keys(list.erc20)
}
