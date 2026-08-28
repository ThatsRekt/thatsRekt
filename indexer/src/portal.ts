import {
  HttpClient,
  type FetchRequest,
  type HttpBody,
  type HttpResponse,
  type RequestOptions,
} from '@subsquid/http-client'
import type { ChainSource } from './chains'

export const REGISTRY_PORTAL_RETRY_DEADLINE_MS = 15 * 60_000

export interface PortalEnvironment {
  readonly [key: string]: string | undefined
  readonly PORTAL_URL?: string
  readonly PORTAL_API_KEY?: string
}

export interface PortalRetryObserver {
  onRetry(input: {
    readonly retryAfterSeconds: number
    readonly retryCount: number
  }): void
  onDeadline(input: { readonly retryCount: number }): void
}

export interface PortalConfig {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly http: HttpClient
  readonly bindRetryObserver: (observer: PortalRetryObserver) => void
}

export class PortalConfigurationError extends Error {
  constructor(variableName: 'PORTAL_URL') {
    super(`Invalid required environment variable: ${variableName}`)
    this.name = 'PortalConfigurationError'
  }
}

export class PortalRetryDeadlineError extends Error {
  constructor() {
    super('Portal retry deadline exceeded after 15 minutes')
    this.name = 'PortalRetryDeadlineError'
  }
}

interface PortalRetryState {
  readonly failureStartedAtMs: number
  retryCount: number
}

export const retryDelayMs = (retryAfter: string | null): number | undefined => {
  if (retryAfter === null || !/^\d+$/.test(retryAfter.trim())) return undefined
  return Number.parseInt(retryAfter, 10) * 1_000
}

export const REGISTRY_PORTAL_RETRY_AFTER_MS = retryDelayMs('10') ?? 10_000

export const assertRetryWithinDeadline = ({
  startedAtMs,
  nowMs,
  retryAfterMs,
  deadlineMs,
}: {
  readonly startedAtMs: number
  readonly nowMs: number
  readonly retryAfterMs: number
  readonly deadlineMs: number
}): void => {
  if (nowMs - startedAtMs >= deadlineMs) {
    throw new PortalRetryDeadlineError()
  }

  if (nowMs - startedAtMs + retryAfterMs > deadlineMs) {
    throw new PortalRetryDeadlineError()
  }
}

class DeadlineHttpClient extends HttpClient {
  readonly #retryStates = new Map<number, PortalRetryState>()
  constructor({
    headers,
    deadlineMs,
    retryScheduleMs,
  }: {
    readonly headers: Readonly<Record<string, string>>
    readonly deadlineMs: number
    readonly retryScheduleMs: readonly number[]
  }) {
    super({
      headers,
      httpTimeout: 30_000,
      log: null,
      retryAttempts: Number.MAX_SAFE_INTEGER,
      retrySchedule: [...retryScheduleMs],
    })
    this.#deadlineMs = deadlineMs
  }

  readonly #deadlineMs: number
  #retryObserver: PortalRetryObserver | undefined
  setRetryObserver(observer: PortalRetryObserver): void {
    this.#retryObserver = observer
  }

  override request<T = unknown>(
    method: string,
    url: string,
    options: RequestOptions & HttpBody = {},
  ): Promise<HttpResponse<T>> {
    // PortalClient supplies `retryAttempts: 6` on every source request, which
    // would otherwise override this client's deadline-governed retry policy.
    return super.request<T>(method, url, {
      ...options,
      retryAttempts: Number.MAX_SAFE_INTEGER,
    })
  }

  protected override beforeRetryPause(
    request: FetchRequest,
    reason: Error | HttpResponse,
    pause: number,
  ): void {
    const nowMs = Date.now()
    const retryState = this.#retryStates.get(request.id) ?? {
      failureStartedAtMs: nowMs,
      retryCount: 0,
    }
    const retryCount = retryState.retryCount + 1
    try {
      assertRetryWithinDeadline({
        startedAtMs: retryState.failureStartedAtMs,
        nowMs,
        retryAfterMs: pause,
        deadlineMs: this.#deadlineMs,
      })
    } catch (error) {
      if (error instanceof PortalRetryDeadlineError) {
        this.#retryStates.delete(request.id)
        this.#retryObserver?.onDeadline({ retryCount })
      }
      throw error
    }
    retryState.retryCount = retryCount
    this.#retryStates.set(request.id, retryState)
    this.#retryObserver?.onRetry({
      retryAfterSeconds: pause / 1_000,
      retryCount,
    })
    super.beforeRetryPause(request, reason, pause)
  }

  protected override afterResponse(request: FetchRequest, response: HttpResponse): void {
    if (response.ok || !this.isRetryableError(response, request)) {
      this.#retryStates.delete(request.id)
    }
    super.afterResponse(request, response)
  }
}

const createDeadlineHttpClient = ({
  headers,
  deadlineMs = REGISTRY_PORTAL_RETRY_DEADLINE_MS,
  retryScheduleMs = [REGISTRY_PORTAL_RETRY_AFTER_MS],
}: {
  readonly headers: Readonly<Record<string, string>>
  readonly deadlineMs?: number
  readonly retryScheduleMs?: readonly number[]
}): DeadlineHttpClient =>
  new DeadlineHttpClient({
    headers,
    deadlineMs,
    retryScheduleMs,
  })

export const createPortalHttpClient = ({
  headers,
  deadlineMs = REGISTRY_PORTAL_RETRY_DEADLINE_MS,
  retryScheduleMs = [REGISTRY_PORTAL_RETRY_AFTER_MS],
  retryObserver,
}: {
  readonly headers: Readonly<Record<string, string>>
  readonly deadlineMs?: number
  readonly retryScheduleMs?: readonly number[]
  readonly retryObserver?: PortalRetryObserver
}): HttpClient => {
  const http = createDeadlineHttpClient({
    headers,
    deadlineMs,
    retryScheduleMs,
  })
  if (retryObserver !== undefined) http.setRetryObserver(retryObserver)
  return http
}
const portalEndpoint = ({
  baseUrl,
  dataset,
}: {
  readonly baseUrl: string
  readonly dataset: string
}): string => {
  const parsed = new URL(baseUrl)
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new PortalConfigurationError('PORTAL_URL')
  }

  const basePath = parsed.pathname.replace(/\/$/, '')
  parsed.pathname = `${basePath}/${dataset}`
  return parsed.toString()
}

export const buildPortalConfig = ({
  source,
  environment,
}: {
  readonly source: ChainSource
  readonly environment: PortalEnvironment
}): PortalConfig => {
  if (source.kind !== 'portal') {
    throw new Error('RPC-only chain does not use a Portal Dataset Endpoint')
  }

  const portalUrl = environment.PORTAL_URL?.trim()
  if (!portalUrl) throw new PortalConfigurationError('PORTAL_URL')

  let url: string
  try {
    url = portalEndpoint({ baseUrl: portalUrl, dataset: source.dataset })
  } catch (error) {
    if (error instanceof PortalConfigurationError) throw error
    throw new PortalConfigurationError('PORTAL_URL')
  }

  const apiKey = environment.PORTAL_API_KEY?.trim()
  const headers: Readonly<Record<string, string>> =
    apiKey === undefined || apiKey === ''
      ? {}
      : { 'x-api-key': apiKey }

  const http = createDeadlineHttpClient({
    headers,
  })
  return {
    url,
    headers,
    http,
    bindRetryObserver(observer: PortalRetryObserver): void {
      http.setRetryObserver(observer)
    },
  }
}
