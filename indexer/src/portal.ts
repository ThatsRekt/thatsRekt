import {
  HttpClient,
  HttpResponse,
  type FetchRequest,
} from '@subsquid/http-client'
import type { ChainSource } from './chains'

export const REGISTRY_PORTAL_RETRY_DEADLINE_MS = 15 * 60_000

export interface PortalEnvironment {
  readonly [key: string]: string | undefined
  readonly PORTAL_URL?: string
  readonly PORTAL_API_KEY?: string
}

export interface PortalConfig {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly http: HttpClient
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
  #failureStartedAtMs: number | undefined

  constructor({
    headers,
    deadlineMs,
  }: {
    readonly headers: Readonly<Record<string, string>>
    readonly deadlineMs: number
  }) {
    super({
      headers,
      httpTimeout: 30_000,
      log: null,
      retryAttempts: Number.MAX_SAFE_INTEGER,
      retrySchedule: [REGISTRY_PORTAL_RETRY_AFTER_MS],
    })
    this.#deadlineMs = deadlineMs
  }

  readonly #deadlineMs: number

  protected override beforeRetryPause(
    request: FetchRequest,
    reason: Error | HttpResponse,
    pause: number,
  ): void {
    const nowMs = Date.now()
    this.#failureStartedAtMs ??= nowMs
    assertRetryWithinDeadline({
      startedAtMs: this.#failureStartedAtMs,
      nowMs,
      retryAfterMs: pause,
      deadlineMs: this.#deadlineMs,
    })
    super.beforeRetryPause(request, reason, pause)
  }

  protected override afterResponse(request: FetchRequest, response: HttpResponse): void {
    if (response.ok) this.#failureStartedAtMs = undefined
    super.afterResponse(request, response)
  }
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

  return {
    url,
    headers,
    http: new DeadlineHttpClient({
      headers,
      deadlineMs: REGISTRY_PORTAL_RETRY_DEADLINE_MS,
    }),
  }
}
