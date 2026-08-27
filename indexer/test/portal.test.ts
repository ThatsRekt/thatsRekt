import { describe, expect, test } from 'bun:test'
import { CHAINS } from '../src/chains'
import {
  buildPortalConfig,
  createPortalHttpClient,
  PortalConfigurationError,
  PortalRetryDeadlineError,
  retryDelayMs,
  assertRetryWithinDeadline,
  REGISTRY_PORTAL_RETRY_DEADLINE_MS,
} from '../src/portal'
import { buildProcessor } from '../src/processor'

const PORTAL_ENV = Object.freeze({
  PORTAL_URL: 'https://portal.example.test/datasets',
})

const EXPECTED_DATASETS = Object.freeze({
  ethereum: 'ethereum-mainnet',
  base: 'base-mainnet',
  arbitrum: 'arbitrum-one',
  optimism: 'optimism-mainnet',
  bsc: 'binance-mainnet',
  polygon: 'polygon-mainnet',
})

describe('Registry Portal production source selection', () => {
  for (const [slug, dataset] of Object.entries(EXPECTED_DATASETS)) {
    test(`${slug} selects only ${dataset}`, () => {
      const config = buildPortalConfig({
        source: CHAINS[slug as keyof typeof CHAINS].source,
        environment: PORTAL_ENV,
      })

      expect(config.url).toBe(`https://portal.example.test/datasets/${dataset}`)
    })
  }

  test('omits x-api-key in public mode', () => {
    const config = buildPortalConfig({
      source: CHAINS.base.source,
      environment: PORTAL_ENV,
    })

    expect(config.headers).toEqual({})
  })

  test('sends only x-api-key when Portal Authentication is configured', () => {
    const config = buildPortalConfig({
      source: CHAINS.base.source,
      environment: {
        ...PORTAL_ENV,
        PORTAL_API_KEY: 'test-key',
      },
    })

    expect(config.headers).toEqual({ 'x-api-key': 'test-key' })
  })

  test('forwards configured Portal authentication on real HTTP requests', async () => {
    let receivedApiKey: string | null = null
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        receivedApiKey = request.headers.get('x-api-key')
        return Response.json({})
      },
    })

    try {
      const config = buildPortalConfig({
        source: CHAINS.base.source,
        environment: {
          ...PORTAL_ENV,
          PORTAL_API_KEY: 'test-key',
        },
      })
      await config.http.get(`http://127.0.0.1:${server.port}`)
    } finally {
      server.stop(true)
    }

    expect(receivedApiKey).toBe('test-key')
  })

  test('treats a blank Portal key as public mode', () => {
    const config = buildPortalConfig({
      source: CHAINS.base.source,
      environment: {
        ...PORTAL_ENV,
        PORTAL_API_KEY: '   ',
      },
    })

    expect(config.headers).toEqual({})
  })

  test('rejects a missing Portal URL without echoing configuration', () => {
    const secretLikeValue = 'https://private.example.test/should-not-appear'

    expect(() =>
      buildPortalConfig({
        source: CHAINS.base.source,
        environment: { PORTAL_URL: secretLikeValue.replace(/.+/, '') },
      }),
    ).toThrow(PortalConfigurationError)

    try {
      buildPortalConfig({
        source: CHAINS.base.source,
        environment: { PORTAL_URL: secretLikeValue.replace(/.+/, '') },
      })
    } catch (error) {
      expect(String(error)).toContain('PORTAL_URL')
      expect(String(error)).not.toContain(secretLikeValue)
    }
  })

  test('rejects an invalid Portal URL without echoing configuration', () => {
    const invalidValue = 'http://private.example.test/datasets'

    expect(() =>
      buildPortalConfig({
        source: CHAINS.base.source,
        environment: { PORTAL_URL: invalidValue },
      }),
    ).toThrow(PortalConfigurationError)

    try {
      buildPortalConfig({
        source: CHAINS.base.source,
        environment: { PORTAL_URL: invalidValue },
      })
    } catch (error) {
      expect(String(error)).toContain('PORTAL_URL')
      expect(String(error)).not.toContain(invalidValue)
    }
  })

  test.each(['anvil-eth', 'anvil-base', 'sepolia', 'base-sepolia'] as const)(
    '%s remains explicitly RPC-only',
    (slug) => {
      expect(CHAINS[slug].source.kind).toBe('rpc')
      expect(() =>
        buildPortalConfig({
          source: CHAINS[slug].source,
          environment: PORTAL_ENV,
        }),
      ).toThrow('RPC-only')
    },
  )
})

describe('Registry Portal retry deadline', () => {
  test('honors Retry-After: 10 in milliseconds', () => {
    expect(retryDelayMs('10')).toBe(10_000)
  })

  test('permits a retry before the 15-minute deadline', () => {
    expect(() =>
      assertRetryWithinDeadline({
        startedAtMs: 0,
        nowMs: 14 * 60_000,
        retryAfterMs: 10_000,
        deadlineMs: REGISTRY_PORTAL_RETRY_DEADLINE_MS,
      }),
    ).not.toThrow()
  })

  test('fails visibly at the 15-minute deadline without another retry', () => {
    expect(() =>
      assertRetryWithinDeadline({
        startedAtMs: 0,
        nowMs: REGISTRY_PORTAL_RETRY_DEADLINE_MS,
        retryAfterMs: 10_000,
        deadlineMs: REGISTRY_PORTAL_RETRY_DEADLINE_MS,
      }),
    ).toThrow(PortalRetryDeadlineError)
  })

  test('uses Retry-After=10 from a controlled 529 transport response', async () => {
    let requests = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        requests += 1
        return new Response('retry later', {
          status: 529,
          headers: { 'Retry-After': '10' },
        })
      },
    })

    try {
      const http = createPortalHttpClient({
        headers: {},
        deadlineMs: 9_999,
        retryScheduleMs: [1],
      })
      await expect(http.get(`http://127.0.0.1:${server.port}`)).rejects.toThrow(
        PortalRetryDeadlineError,
      )
    } finally {
      server.stop(true)
    }

    expect(requests).toBe(1)
  })
})

describe('Registry Portal processor construction', () => {
  test('builds a production Portal source without an RPC URL', () => {
    const previousEnvironment = {
      PORTAL_URL: process.env.PORTAL_URL,
      PORTAL_API_KEY: process.env.PORTAL_API_KEY,
      CONTRACT_BASE: process.env.CONTRACT_BASE,
      START_BLOCK_BASE: process.env.START_BLOCK_BASE,
      RPC_BASE_HTTP: process.env.RPC_BASE_HTTP,
    }
    process.env.PORTAL_URL = PORTAL_ENV.PORTAL_URL
    process.env.PORTAL_API_KEY = ''
    process.env.CONTRACT_BASE = '0x0000000000000000000000000000000001'
    process.env.START_BLOCK_BASE = '48658531'
    delete process.env.RPC_BASE_HTTP

    try {
      const built = buildProcessor(CHAINS.base)
      expect(built.kind).toBe('portal')
    } finally {
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test('builds Local Anvil Forks through their explicit RPC-only path', () => {
    const previousEnvironment = {
      CONTRACT_ANVIL_BASE: process.env.CONTRACT_ANVIL_BASE,
      START_BLOCK_ANVIL_BASE: process.env.START_BLOCK_ANVIL_BASE,
      RPC_ANVIL_BASE_HTTP: process.env.RPC_ANVIL_BASE_HTTP,
    }
    process.env.CONTRACT_ANVIL_BASE = '0x0000000000000000000000000000000001'
    process.env.START_BLOCK_ANVIL_BASE = '0'
    process.env.RPC_ANVIL_BASE_HTTP = 'http://127.0.0.1:8545'

    try {
      const built = buildProcessor(CHAINS['anvil-base'])
      expect(built.kind).toBe('rpc')
    } finally {
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
