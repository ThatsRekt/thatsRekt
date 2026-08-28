import { describe, expect, test } from 'bun:test'
import {
  DONATIONS_PORTAL_RETRY_DEADLINE_MS,
  DonationsPortalConfigurationError,
  DonationsPortalRetryDeadlineError,
  assertRetryWithinDeadline,
  buildPortalConfig,
  createPortalHttpClient,
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
        DonationsPortalRetryDeadlineError,
      )
    } finally {
      server.stop(true)
    }

    expect(requests).toBe(1)
  })

  test('reports only numeric retry and deadline state to its observer', async () => {
    const retryEvents: {
      readonly retryAfterSeconds: number
      readonly retryCount: number
    }[] = []
    let retryRequests = 0
    const retryServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        retryRequests += 1
        return retryRequests === 1
          ? new Response('retry', {
            status: 529,
            headers: { 'Retry-After': '0' },
          })
          : Response.json({})
      },
    })
    const deadlineEvents: { readonly retryCount: number }[] = []
    const deadlineServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response('retry', {
          status: 529,
          headers: { 'Retry-After': '10' },
        })
      },
    })

    try {
      await createPortalHttpClient({
        headers: {},
        retryScheduleMs: [1],
        retryObserver: {
          onRetry: (event) => retryEvents.push(event),
          onDeadline: () => {},
        },
      }).get(`http://127.0.0.1:${retryServer.port}`)
      await expect(
        createPortalHttpClient({
          headers: {},
          deadlineMs: 9_999,
          retryScheduleMs: [1],
          retryObserver: {
            onRetry: () => {},
            onDeadline: (event) => deadlineEvents.push(event),
          },
        }).get(`http://127.0.0.1:${deadlineServer.port}`),
      ).rejects.toThrow(DonationsPortalRetryDeadlineError)
    } finally {
      retryServer.stop(true)
      deadlineServer.stop(true)
    }

    expect(retryEvents).toEqual([{ retryAfterSeconds: 0, retryCount: 1 }])
    expect(deadlineEvents).toEqual([{ retryCount: 1 }])
  })

  test('keeps concurrent Portal retries isolated from successful freshness probes', async () => {
    const retryEvents: { readonly retryCount: number }[] = []
    let notifyFirstRetry: (() => void) | undefined
    let retryRequests = 0
    const firstRetry = new Promise<void>((resolve) => {
      notifyFirstRetry = resolve
    })
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === '/retry') {
          retryRequests += 1
          return retryRequests < 3
            ? new Response('retry', { status: 529, headers: { 'Retry-After': '1' } })
            : Response.json({})
        }
        return Response.json({})
      },
    })

    try {
      const http = createPortalHttpClient({
        headers: {},
        deadlineMs: 5_000,
        retryScheduleMs: [100],
        retryObserver: {
          onRetry: (event) => {
            retryEvents.push(event)
            if (retryEvents.length === 1) notifyFirstRetry?.()
          },
          onDeadline: () => {},
        },
      })
      const retryRequest = http.get(`http://127.0.0.1:${server.port}/retry`)
      await firstRetry
      await http.get(`http://127.0.0.1:${server.port}/success`)
      await retryRequest
    } finally {
      server.stop(true)
    }

    expect(retryEvents.map((event) => event.retryCount)).toEqual([1, 2])
  })
})
