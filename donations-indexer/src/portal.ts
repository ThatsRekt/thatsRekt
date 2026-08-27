import {
  HttpClient,
  HttpResponse,
  type FetchRequest,
} from '@subsquid/http-client'

export const DONATIONS_PORTAL_RETRY_DEADLINE_MS = 20 * 60_000

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

export class DonationsPortalConfigurationError extends Error {
  constructor(variableName: 'PORTAL_URL') {
    super(`Invalid required environment variable: ${variableName}`)
    this.name = 'DonationsPortalConfigurationError'
  }
}

export class DonationsPortalRetryDeadlineError extends Error {
  constructor() {
    super('Portal retry deadline exceeded after 20 minutes')
    this.name = 'DonationsPortalRetryDeadlineError'
  }
}

export const retryDelayMs = (retryAfter: string | null): number | undefined => {
  if (retryAfter === null || !/^\d+$/.test(retryAfter.trim())) return undefined

  return Number.parseInt(retryAfter, 10) * 1_000
}

export const DONATIONS_PORTAL_RETRY_AFTER_MS = retryDelayMs('10') ?? 10_000

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
  if (nowMs - startedAtMs >= deadlineMs || nowMs + retryAfterMs - startedAtMs > deadlineMs) {
    throw new DonationsPortalRetryDeadlineError()
  }
}

class DeadlineHttpClient extends HttpClient {
  readonly #deadlineMs: number
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
      retrySchedule: [DONATIONS_PORTAL_RETRY_AFTER_MS],
      httpTimeout: 30_000,
      log: null,
      retryAttempts: Number.MAX_SAFE_INTEGER,
    })
    this.#deadlineMs = deadlineMs
  }

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
    throw new DonationsPortalConfigurationError('PORTAL_URL')
  }

  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/${dataset}`
  return parsed.toString()
}

export const buildPortalConfig = ({
  dataset,
  environment,
}: {
  readonly dataset: string
  readonly environment: PortalEnvironment
}): PortalConfig => {
  const portalUrl = environment.PORTAL_URL?.trim()
  if (!portalUrl) throw new DonationsPortalConfigurationError('PORTAL_URL')

  let url: string
  try {
    url = portalEndpoint({ baseUrl: portalUrl, dataset })
  } catch (error) {
    if (error instanceof DonationsPortalConfigurationError) throw error
    throw new DonationsPortalConfigurationError('PORTAL_URL')
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
      deadlineMs: DONATIONS_PORTAL_RETRY_DEADLINE_MS,
    }),
  }
}
