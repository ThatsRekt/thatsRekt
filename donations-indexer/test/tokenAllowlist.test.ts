/**
 * Unit tests for tokenAllowlist — pure module, no I/O.
 * Written test-first (TDD).
 *
 * Slice #207 additions: ERC20 allowlist lookups, erc20Addresses(), TRANSFER_TOPIC0.
 * Slice #209 additions: Base, Arbitrum, Optimism, BSC, Polygon chain coverage.
 */
import { describe, expect, test } from 'bun:test'
import {
  allowlistFor,
  isAllowed,
  nativeFloor,
  tokenMeta,
  erc20Addresses,
  TRANSFER_TOPIC0,
} from '../src/tokenAllowlist.ts'

describe('allowlistFor', () => {
  test('returns non-null for Ethereum mainnet (chainId 1)', () => {
    expect(allowlistFor(1)).not.toBeNull()
  })

  test('returns null for unknown chain', () => {
    expect(allowlistFor(999999)).toBeNull()
  })

  test('Ethereum allowlist has native entry with ETH symbol', () => {
    const list = allowlistFor(1)
    expect(list?.native.symbol).toBe('ETH')
    expect(list?.native.decimals).toBe(18)
  })

  test('Ethereum nativeFloorWei is greater than 0', () => {
    const list = allowlistFor(1)
    expect(list!.nativeFloorWei).toBeGreaterThan(0n)
  })

  test('Ethereum allowlist has exactly 9 ERC20 entries', () => {
    const list = allowlistFor(1)
    expect(Object.keys(list!.erc20)).toHaveLength(9)
  })
})

describe('isAllowed', () => {
  test('native (null tokenAddress) is allowed on Ethereum', () => {
    expect(isAllowed(1, null)).toBe(true)
  })

  test('unknown token address is NOT allowed on Ethereum', () => {
    expect(isAllowed(1, '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(false)
  })

  test('native is NOT allowed on unknown chain', () => {
    expect(isAllowed(999999, null)).toBe(false)
  })

  // ERC20 allowlist — canonical addresses (checksummed form — isAllowed lowercases internally)
  test('USDC (0xA0b86991...) is allowed on Ethereum', () => {
    expect(isAllowed(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(true)
  })

  test('USDT (0xdAC17F95...) is allowed on Ethereum', () => {
    expect(isAllowed(1, '0xdAC17F958D2ee523a2206206994597C13D831ec7')).toBe(true)
  })

  test('DAI (0x6B175474...) is allowed on Ethereum', () => {
    expect(isAllowed(1, '0x6B175474E89094C44Da98b954EedeAC495271d0F')).toBe(true)
  })

  test('WETH (0xC02aaA39...) is allowed on Ethereum', () => {
    expect(isAllowed(1, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')).toBe(true)
  })

  test('WBTC (0x2260FAC5...) is allowed on Ethereum', () => {
    expect(isAllowed(1, '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599')).toBe(true)
  })

  test('stETH (0xae7ab965...) is allowed on Ethereum', () => {
    expect(isAllowed(1, '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84')).toBe(true)
  })

  test('wstETH (0x7f39C581...) is allowed on Ethereum', () => {
    expect(isAllowed(1, '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0')).toBe(true)
  })

  test('LINK (0x514910771...) is allowed on Ethereum', () => {
    expect(isAllowed(1, '0x514910771AF9Ca656af840dff83E8264EcF986CA')).toBe(true)
  })

  test('AAVE (0x7Fc66500...) is allowed on Ethereum', () => {
    expect(isAllowed(1, '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9')).toBe(true)
  })

  test('lowercased address variant is also allowed (case-insensitive lookup)', () => {
    expect(isAllowed(1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(true)
  })
})

describe('nativeFloor', () => {
  test('Ethereum floor is positive (100000000000000 wei)', () => {
    const floor = nativeFloor(1)
    expect(floor).toBe(100_000_000_000_000n)
  })

  test('unknown chain returns 0n (fail-open)', () => {
    expect(nativeFloor(999999)).toBe(0n)
  })
})

describe('tokenMeta', () => {
  test('native token meta on Ethereum: ETH, 18 decimals', () => {
    const meta = tokenMeta(1, null)
    expect(meta).not.toBeNull()
    expect(meta!.symbol).toBe('ETH')
    expect(meta!.decimals).toBe(18)
  })

  test('unknown ERC20 on Ethereum returns null', () => {
    expect(tokenMeta(1, '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull()
  })

  test('unknown chain returns null', () => {
    expect(tokenMeta(999999, null)).toBeNull()
  })

  // Per-token decimals — the syrupUSDC lesson: always verify, never assume 18.
  test('USDC decimals = 6 (verified on-chain)', () => {
    const meta = tokenMeta(1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
    expect(meta).not.toBeNull()
    expect(meta!.symbol).toBe('USDC')
    expect(meta!.decimals).toBe(6)
  })

  test('USDT decimals = 6 (verified on-chain)', () => {
    const meta = tokenMeta(1, '0xdac17f958d2ee523a2206206994597c13d831ec7')
    expect(meta).not.toBeNull()
    expect(meta!.symbol).toBe('USDT')
    expect(meta!.decimals).toBe(6)
  })

  test('DAI decimals = 18 (verified on-chain)', () => {
    const meta = tokenMeta(1, '0x6b175474e89094c44da98b954eedeac495271d0f')
    expect(meta).not.toBeNull()
    expect(meta!.symbol).toBe('DAI')
    expect(meta!.decimals).toBe(18)
  })

  test('WETH decimals = 18 (verified on-chain)', () => {
    const meta = tokenMeta(1, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
    expect(meta).not.toBeNull()
    expect(meta!.symbol).toBe('WETH')
    expect(meta!.decimals).toBe(18)
  })

  test('WBTC decimals = 8 (verified on-chain; NOT 18)', () => {
    const meta = tokenMeta(1, '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599')
    expect(meta).not.toBeNull()
    expect(meta!.symbol).toBe('WBTC')
    expect(meta!.decimals).toBe(8)
  })

  test('stETH decimals = 18 (verified on-chain)', () => {
    const meta = tokenMeta(1, '0xae7ab96520de3a18e5e111b5eaab095312d7fe84')
    expect(meta).not.toBeNull()
    expect(meta!.symbol).toBe('stETH')
    expect(meta!.decimals).toBe(18)
  })

  test('wstETH decimals = 18 (verified on-chain)', () => {
    const meta = tokenMeta(1, '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0')
    expect(meta).not.toBeNull()
    expect(meta!.symbol).toBe('wstETH')
    expect(meta!.decimals).toBe(18)
  })

  test('LINK decimals = 18 (verified on-chain)', () => {
    const meta = tokenMeta(1, '0x514910771af9ca656af840dff83e8264ecf986ca')
    expect(meta).not.toBeNull()
    expect(meta!.symbol).toBe('LINK')
    expect(meta!.decimals).toBe(18)
  })

  test('AAVE decimals = 18 (verified on-chain)', () => {
    const meta = tokenMeta(1, '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9')
    expect(meta).not.toBeNull()
    expect(meta!.symbol).toBe('AAVE')
    expect(meta!.decimals).toBe(18)
  })
})

describe('erc20Addresses', () => {
  test('returns 9 addresses for Ethereum mainnet', () => {
    const addrs = erc20Addresses(1)
    expect(addrs).toHaveLength(9)
  })

  test('all addresses are lowercased', () => {
    const addrs = erc20Addresses(1)
    for (const addr of addrs) {
      expect(addr).toBe(addr.toLowerCase())
    }
  })

  test('all addresses start with 0x and have 42 characters', () => {
    const addrs = erc20Addresses(1)
    for (const addr of addrs) {
      expect(addr).toMatch(/^0x[0-9a-f]{40}$/)
    }
  })

  test('returns empty array for unknown chain', () => {
    expect(erc20Addresses(999999)).toHaveLength(0)
  })

  test('USDC address present in Ethereum list', () => {
    const addrs = erc20Addresses(1)
    expect(addrs).toContain('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
  })

  test('WBTC address present in Ethereum list', () => {
    const addrs = erc20Addresses(1)
    expect(addrs).toContain('0x2260fac5e5542a773aa44fbcfedf7c193bc2c599')
  })
})

describe('TRANSFER_TOPIC0', () => {
  test('has correct keccak256 of Transfer(address,address,uint256)', () => {
    // keccak256("Transfer(address,address,uint256)") — canonical value
    expect(TRANSFER_TOPIC0).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    )
  })

  test('is 66 characters (0x + 64 hex)', () => {
    expect(TRANSFER_TOPIC0).toHaveLength(66)
  })
})

// ---------------------------------------------------------------------------
// Slice #209: new chain coverage
// ---------------------------------------------------------------------------

describe('allowlistFor — new chains (slice #209)', () => {
  test('returns non-null for Base (chainId 8453)', () => {
    expect(allowlistFor(8453)).not.toBeNull()
  })

  test('returns non-null for Arbitrum (chainId 42161)', () => {
    expect(allowlistFor(42161)).not.toBeNull()
  })

  test('returns non-null for Optimism (chainId 10)', () => {
    expect(allowlistFor(10)).not.toBeNull()
  })

  test('returns non-null for BSC (chainId 56)', () => {
    expect(allowlistFor(56)).not.toBeNull()
  })

  test('returns non-null for Polygon (chainId 137)', () => {
    expect(allowlistFor(137)).not.toBeNull()
  })

  test('Base native symbol is ETH', () => {
    expect(allowlistFor(8453)?.native.symbol).toBe('ETH')
  })

  test('Arbitrum native symbol is ETH', () => {
    expect(allowlistFor(42161)?.native.symbol).toBe('ETH')
  })

  test('Optimism native symbol is ETH', () => {
    expect(allowlistFor(10)?.native.symbol).toBe('ETH')
  })

  test('BSC native symbol is BNB', () => {
    expect(allowlistFor(56)?.native.symbol).toBe('BNB')
  })

  test('Polygon native symbol is POL', () => {
    expect(allowlistFor(137)?.native.symbol).toBe('POL')
  })

  test('Base has exactly 9 ERC20 entries', () => {
    expect(Object.keys(allowlistFor(8453)!.erc20)).toHaveLength(9)
  })

  test('Arbitrum has exactly 9 ERC20 entries', () => {
    expect(Object.keys(allowlistFor(42161)!.erc20)).toHaveLength(9)
  })

  test('Optimism has exactly 9 ERC20 entries', () => {
    expect(Object.keys(allowlistFor(10)!.erc20)).toHaveLength(9)
  })

  test('BSC has exactly 9 ERC20 entries', () => {
    expect(Object.keys(allowlistFor(56)!.erc20)).toHaveLength(9)
  })

  test('Polygon has exactly 9 ERC20 entries', () => {
    expect(Object.keys(allowlistFor(137)!.erc20)).toHaveLength(9)
  })
})

describe('native dust floors — new chains', () => {
  test('Base nativeFloor is 0.0001 ETH (100_000_000_000_000 wei)', () => {
    expect(nativeFloor(8453)).toBe(100_000_000_000_000n)
  })

  test('Arbitrum nativeFloor is 0.0001 ETH', () => {
    expect(nativeFloor(42161)).toBe(100_000_000_000_000n)
  })

  test('Optimism nativeFloor is 0.0001 ETH', () => {
    expect(nativeFloor(10)).toBe(100_000_000_000_000n)
  })

  test('BSC nativeFloor is 0.001 BNB (1_000_000_000_000_000 wei)', () => {
    expect(nativeFloor(56)).toBe(1_000_000_000_000_000n)
  })

  test('Polygon nativeFloor is 1 POL (1_000_000_000_000_000_000 wei)', () => {
    expect(nativeFloor(137)).toBe(1_000_000_000_000_000_000n)
  })
})

describe('tokenMeta — new chains (decimals critical, cross-chain gotchas)', () => {
  // Base
  test('Base USDC decimals = 6 (native Circle USDC on Base)', () => {
    const meta = tokenMeta(8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
    expect(meta?.symbol).toBe('USDC')
    expect(meta?.decimals).toBe(6)
  })

  test('Base cbBTC decimals = 8 (NOT 18)', () => {
    const meta = tokenMeta(8453, '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf')
    expect(meta?.symbol).toBe('cbBTC')
    expect(meta?.decimals).toBe(8)
  })

  test('Base rETH decimals = 18', () => {
    const meta = tokenMeta(8453, '0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c')
    expect(meta?.symbol).toBe('rETH')
    expect(meta?.decimals).toBe(18)
  })

  // Arbitrum
  test('Arbitrum USDC decimals = 6 (native Circle USDC)', () => {
    const meta = tokenMeta(42161, '0xaf88d065e77c8cc2239327c5edb3a432268e5831')
    expect(meta?.symbol).toBe('USDC')
    expect(meta?.decimals).toBe(6)
  })

  test('Arbitrum USDT decimals = 6 (NOT 18; bridged Tether)', () => {
    const meta = tokenMeta(42161, '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9')
    expect(meta?.symbol).toBe('USDT')
    expect(meta?.decimals).toBe(6)
  })

  test('Arbitrum WBTC decimals = 8 (NOT 18)', () => {
    const meta = tokenMeta(42161, '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f')
    expect(meta?.symbol).toBe('WBTC')
    expect(meta?.decimals).toBe(8)
  })

  // Optimism
  test('Optimism USDC decimals = 6', () => {
    const meta = tokenMeta(10, '0x0b2c639c533813f4aa9d7837caf62653d097ff85')
    expect(meta?.symbol).toBe('USDC')
    expect(meta?.decimals).toBe(6)
  })

  test('Optimism WBTC decimals = 8 (NOT 18)', () => {
    const meta = tokenMeta(10, '0x68f180fcce6836688e9084f035309e29bf0a2095')
    expect(meta?.symbol).toBe('WBTC')
    expect(meta?.decimals).toBe(8)
  })

  // BSC — critical: 18-decimal USDC/USDT/BTCB
  test('BSC USDC decimals = 18 (Binance-pegged BEP20, NOT 6)', () => {
    const meta = tokenMeta(56, '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d')
    expect(meta?.symbol).toBe('USDC')
    // 18 — this is the most common cross-chain decimal gotcha for BSC
    expect(meta?.decimals).toBe(18)
  })

  test('BSC USDT decimals = 18 (Binance-pegged BEP20, NOT 6)', () => {
    const meta = tokenMeta(56, '0x55d398326f99059ff775485246999027b3197955')
    expect(meta?.symbol).toBe('USDT')
    expect(meta?.decimals).toBe(18)
  })

  test('BSC BTCB decimals = 18 (Binance-pegged Bitcoin, NOT 8)', () => {
    const meta = tokenMeta(56, '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c')
    expect(meta?.symbol).toBe('BTCB')
    expect(meta?.decimals).toBe(18)
  })

  // Polygon
  test('Polygon USDC decimals = 6 (native Circle USDC)', () => {
    const meta = tokenMeta(137, '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359')
    expect(meta?.symbol).toBe('USDC')
    expect(meta?.decimals).toBe(6)
  })

  test('Polygon USDT decimals = 6 (onchain symbol USDT0, stored as USDT)', () => {
    const meta = tokenMeta(137, '0xc2132d05d31c914a87c6611c10748aeb04b58e8f')
    expect(meta?.symbol).toBe('USDT')
    expect(meta?.decimals).toBe(6)
  })

  test('Polygon WBTC decimals = 8 (NOT 18)', () => {
    const meta = tokenMeta(137, '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6')
    expect(meta?.symbol).toBe('WBTC')
    expect(meta?.decimals).toBe(8)
  })
})

describe('isAllowed — new chains', () => {
  test('Base USDC is allowed', () => {
    expect(isAllowed(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(true)
  })

  test('BSC USDC is allowed (18 decimals BEP20)', () => {
    expect(isAllowed(56, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d')).toBe(true)
  })

  test('Ethereum USDC address is NOT allowed on Base (different address)', () => {
    // Ethereum USDC: 0xa0b86991...
    expect(isAllowed(8453, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(false)
  })

  test('Polygon AAVE is allowed', () => {
    expect(isAllowed(137, '0xD6DF932A45C0f255f85145f286eA0b292B21C90B')).toBe(true)
  })

  test('Unknown address on Arbitrum is NOT allowed', () => {
    expect(isAllowed(42161, '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(false)
  })
})

describe('erc20Addresses — new chains', () => {
  test('Base returns 9 addresses', () => {
    expect(erc20Addresses(8453)).toHaveLength(9)
  })

  test('Arbitrum returns 9 addresses', () => {
    expect(erc20Addresses(42161)).toHaveLength(9)
  })

  test('Optimism returns 9 addresses', () => {
    expect(erc20Addresses(10)).toHaveLength(9)
  })

  test('BSC returns 9 addresses', () => {
    expect(erc20Addresses(56)).toHaveLength(9)
  })

  test('Polygon returns 9 addresses', () => {
    expect(erc20Addresses(137)).toHaveLength(9)
  })

  test('all Base addresses are lowercased 0x + 40 hex', () => {
    const addrs = erc20Addresses(8453)
    for (const addr of addrs) {
      expect(addr).toMatch(/^0x[0-9a-f]{40}$/)
    }
  })

  test('BSC USDC address present', () => {
    expect(erc20Addresses(56)).toContain('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d')
  })

  test('Polygon WBTC address present', () => {
    expect(erc20Addresses(137)).toContain('0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6')
  })
})
