import { describe, expect, test } from 'bun:test'
import {
  DONATIONS_PORTAL_RETRY_DEADLINE_MS,
  DonationsPortalConfigurationError,
  DonationsPortalRetryDeadlineError,
  assertRetryWithinDeadline,
  buildPortalConfig,
  retryDelayMs,
} from '../src/portal.ts'

const BASE_PORTAL_URL = 'https://portal.example.test/datasets'

describe('Donations Portal configuration', () => {
  test('appends the selected dataset and omits blank authentication', () => {
    const config = buildPortalConfig({
      dataset: 'base-mainnet',
      environment: {
        PORTAL_URL: BASE_PORTAL_URL,
        PORTAL_API_KEY: '  ',
      },
    })

    expect(config.url).toBe('https://portal.example.test/datasets/base-mainnet')
    expect(config.headers).toEqual({})
  })

  test('sends only x-api-key when configured', () => {
    const config = buildPortalConfig({
      dataset: 'ethereum-mainnet',
      environment: {
        PORTAL_URL: BASE_PORTAL_URL,
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
        dataset: 'ethereum-mainnet',
        environment: {
          PORTAL_URL: BASE_PORTAL_URL,
          PORTAL_API_KEY: 'test-key',
        },
      })
      await config.http.get(`http://127.0.0.1:${server.port}`)
    } finally {
      server.stop(true)
    }

    expect(receivedApiKey).toBe('test-key')
  })
  test.each([
    [undefined, 'missing-portal-url'],
    ['', 'blank-portal-url'],
    ['http://portal.example.test/datasets', 'http://portal.example.test/datasets'],
    [
      'https://user:password@portal.example.test/datasets',
      'https://user:password@portal.example.test/datasets',
    ],
  ])('rejects invalid Portal URLs without exposing them: %p', (portalUrl, hiddenValue) => {
    expect(() =>
      buildPortalConfig({
        dataset: 'base-mainnet',
        environment: { PORTAL_URL: portalUrl },
      }),
    ).toThrow(new DonationsPortalConfigurationError('PORTAL_URL'))
    expect(() =>
      buildPortalConfig({
        dataset: 'base-mainnet',
        environment: { PORTAL_URL: portalUrl },
      }),
    ).not.toThrow(hiddenValue)
  })
})

describe('Donations Portal retry deadline', () => {
  test('honors a ten-second Retry-After response', () => {
    expect(retryDelayMs('10')).toBe(10_000)
  })

  test('fails before a retry crosses the twenty-minute deadline', () => {
    expect(() =>
      assertRetryWithinDeadline({
        startedAtMs: 0,
        nowMs: DONATIONS_PORTAL_RETRY_DEADLINE_MS - 5_000,
        retryAfterMs: 10_000,
        deadlineMs: DONATIONS_PORTAL_RETRY_DEADLINE_MS,
      }),
    ).toThrow(DonationsPortalRetryDeadlineError)
  })
})
