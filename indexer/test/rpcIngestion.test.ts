/**
 * Tests for per-chain RPC data-ingestion policy (`ChainConfig.rpcIngestion`).
 *
 * Background — why this setting exists:
 *   Subsquid's hot-block tail fetches one `eth_getBlockByNumber` per block,
 *   forever, on every chain. Measured 2026-07-20 that was ~1.34M JSON-RPC
 *   calls/day across 7 chains, ~87% of it that single method, billed flat
 *   per call. Ethereum carries 38 of the registry's 58 lifetime posts for
 *   3% of that spend; arbitrum carries 4 posts for 50%.
 *
 *   So: mainnet keeps real-time RPC ingestion, every other real chain falls
 *   back to the Subsquid archive alone (measured lag ~25m–2.5h, acceptable
 *   for chains seeing a handful of posts per year).
 *
 * The load-bearing invariant is the last one: `@subsquid/evm-processor`
 * throws "Subsquid Archive is required when RPC data ingestion is disabled"
 * (processor.js:378) at boot. A chain with `gateway: null` and
 * `rpcIngestion: false` would be a crash loop in production, so it must be
 * unrepresentable in config.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { CHAINS, ChainSlug } from '../src/chains'
import { buildProcessor } from '../src/processor'

/** Chains that keep the real-time RPC hot-block tail. */
const RPC_INGESTION_CHAINS: readonly ChainSlug[] = [
  'ethereum',
  // Local Anvil forks have no archive — RPC is their only data source.
  'anvil-eth',
  'anvil-base',
]

describe('ChainConfig.rpcIngestion', () => {
  for (const [slug, cfg] of Object.entries(CHAINS)) {
    test(`${slug} declares rpcIngestion as a boolean`, () => {
      expect(typeof cfg.rpcIngestion).toBe('boolean')
    })
  }
})

describe('RPC ingestion policy', () => {
  test('ethereum keeps real-time RPC ingestion', () => {
    expect(CHAINS['ethereum'].rpcIngestion).toBe(true)
  })

  test.each(['base', 'base-sepolia', 'optimism', 'arbitrum', 'bsc', 'polygon', 'sepolia'] as const)(
    '%s is archive-only',
    (slug) => {
      expect(CHAINS[slug].rpcIngestion).toBe(false)
    },
  )

  test.each(['anvil-eth', 'anvil-base'] as const)(
    '%s keeps RPC ingestion (no archive exists)',
    (slug) => {
      expect(CHAINS[slug].rpcIngestion).toBe(true)
    },
  )

  test('exactly the expected chains use RPC ingestion', () => {
    const actual = Object.values(CHAINS)
      .filter((c) => c.rpcIngestion)
      .map((c) => c.slug)
      .sort()
    expect(actual).toEqual([...RPC_INGESTION_CHAINS].sort())
  })
})

/**
 * The config assertions above prove policy; these prove *wiring*. Without
 * them a `buildProcessor` that silently dropped the call would still pass
 * every test in this file while costing ~1.3M RPC calls/day in production.
 *
 * `rpcIngestSettings` is the private field `@subsquid/evm-processor` reads at
 * `processor.js:385` to decide whether to construct a hot data source. There
 * is no public getter, so the test asserts against the same field the library
 * itself branches on — a narrow, documented reach into internals rather than
 * a blanket `as any` over the processor's public surface.
 */
interface RpcIngestSettingsProbe {
  readonly rpcIngestSettings?: { readonly disabled?: boolean }
}

const ingestSettingsFor = (slug: ChainSlug) =>
  (buildProcessor(CHAINS[slug]).processor as unknown as RpcIngestSettingsProbe)
    .rpcIngestSettings

describe('buildProcessor applies the ingestion policy', () => {
  beforeAll(() => {
    // buildProcessor reads these via requireEnv; values are never dialled.
    for (const suffix of ['ARBITRUM', 'ETHEREUM']) {
      process.env[`CONTRACT_${suffix}`] =
        '0x0000000000000000000000000000000000000001'
      process.env[`START_BLOCK_${suffix}`] = '1'
      process.env[`RPC_${suffix}_HTTP`] = 'https://example.invalid'
    }
  })

  test('archive-only chain disables RPC data ingestion', () => {
    expect(ingestSettingsFor('arbitrum')?.disabled).toBe(true)
  })

  test('mainnet leaves RPC data ingestion enabled', () => {
    expect(ingestSettingsFor('ethereum')?.disabled).toBeUndefined()
  })

  test('archive-only chain still has a gateway configured', () => {
    // Belt and braces: disabling ingestion without an archive throws at boot.
    expect(CHAINS['arbitrum'].gateway).toBeString()
  })
})

describe('safety invariant: archive is required when RPC ingestion is disabled', () => {
  for (const [slug, cfg] of Object.entries(CHAINS)) {
    test(`${slug} never disables RPC ingestion without a gateway`, () => {
      if (cfg.gateway === null) {
        expect(cfg.rpcIngestion).toBe(true)
      }
    })
  }
})
