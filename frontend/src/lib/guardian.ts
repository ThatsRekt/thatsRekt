/**
 * Guardian application client-side helpers.
 *
 * Mirrors the server-side validation from mesh/src/guardian.ts so the form
 * can gate the submit button before the network round-trip. Server is still
 * the real authority; client validation is UX only.
 *
 * Mutation call goes through the existing gqlClient (graphql-request) to
 * keep the network layer consistent with the rest of the app.
 */
import { gqlClient } from './client'

// ---------------------------------------------------------------------------
// Types (match mesh/src/guardian.ts exactly)
// ---------------------------------------------------------------------------

export const CONTACT_TYPES = ['telegram', 'email', 'signal', 'twitter'] as const
export type ContactType = (typeof CONTACT_TYPES)[number]

export const CONTACT_TYPE_LABELS: Record<ContactType, string> = {
  telegram: 'Telegram',
  email: 'Email',
  signal: 'Signal',
  twitter: 'Twitter/X',
}

export const CONTACT_TYPE_PLACEHOLDERS: Record<ContactType, string> = {
  telegram: '@yourhandle',
  email: 'you@example.com',
  signal: '+15555550100',
  twitter: '@yourhandle',
}

export const CONTACT_TYPE_HINTS: Record<ContactType, string> = {
  telegram: '@handle (1-64 alphanumeric + underscore)',
  email: 'valid email address',
  signal: 'E.164 phone number, e.g. +15555550100',
  twitter: '@handle (1-50 alphanumeric + underscore)',
}

export interface ContactInput {
  readonly type: ContactType
  readonly value: string
}

// ---------------------------------------------------------------------------
// Validation constants (mirror server)
// ---------------------------------------------------------------------------

export const JUSTIFICATION_MIN = 50
export const JUSTIFICATION_MAX = 1500
export const CONTACT_VALUE_MAX = 128
/** Maximum number of EXTRA contacts (primary + extras = 3 total). */
export const EXTRA_CONTACTS_MAX = 2

// Per-type format regexes (copied verbatim from mesh/src/guardian.ts).
const TELEGRAM_RE = /^@[A-Za-z0-9_]{1,64}$/
const TWITTER_RE = /^@[A-Za-z0-9_]{1,50}$/
const SIGNAL_RE = /^\+[1-9]\d{6,14}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Validate a contact value for a given type. Pure. Returns null on success,
 * an error string on failure.
 */
export function validateContactValue(type: ContactType, value: string): string | null {
  if (value.length === 0) return 'Value is required'
  if (value.length > CONTACT_VALUE_MAX) return `Max ${CONTACT_VALUE_MAX} characters`
  switch (type) {
    case 'telegram':
      return TELEGRAM_RE.test(value) ? null : 'Must be @handle (letters, digits, underscore)'
    case 'twitter':
      return TWITTER_RE.test(value) ? null : 'Must be @handle (letters, digits, underscore)'
    case 'signal':
      return SIGNAL_RE.test(value) ? null : 'Must be E.164 format, e.g. +15555550100'
    case 'email':
      return EMAIL_RE.test(value) ? null : 'Must be a valid email address'
  }
}

/**
 * Validate justification text. Pure. Returns null on success, an error string
 * on failure.
 */
export function validateJustification(text: string): string | null {
  if (text.length < JUSTIFICATION_MIN)
    return `At least ${JUSTIFICATION_MIN} characters required (${text.length} so far)`
  if (text.length > JUSTIFICATION_MAX)
    return `At most ${JUSTIFICATION_MAX} characters allowed`
  return null
}

// ---------------------------------------------------------------------------
// GraphQL mutation
// ---------------------------------------------------------------------------

const SUBMIT_GUARDIAN_APPLICATION_MUTATION = /* GraphQL */ `
  mutation SubmitGuardianApplication($input: SubmitGuardianApplicationInput!) {
    submitGuardianApplication(input: $input) {
      __typename
      ... on GuardianApplicationSuccess {
        applicationId
      }
      ... on GuardianApplicationError {
        code
        message
      }
    }
  }
`

export type GuardianApplicationErrorCode =
  | 'JustificationTooShort'
  | 'JustificationTooLong'
  | 'InvalidContact'
  | 'TooManyContacts'
  | 'TurnstileFailed'
  | 'InternalError'

interface GuardianApplicationSuccessRaw {
  __typename: 'GuardianApplicationSuccess'
  applicationId: string
}

interface GuardianApplicationErrorRaw {
  __typename: 'GuardianApplicationError'
  code: GuardianApplicationErrorCode
  message: string
}

type GuardianApplicationResultRaw =
  | GuardianApplicationSuccessRaw
  | GuardianApplicationErrorRaw

export type GuardianApplicationResult =
  | { readonly ok: true; readonly applicationId: string }
  | { readonly ok: false; readonly code: GuardianApplicationErrorCode; readonly message: string }

export interface SubmitGuardianApplicationInput {
  readonly justification: string
  readonly primaryContact: ContactInput
  readonly extraContacts: readonly ContactInput[]
  readonly honeypot: string
  readonly turnstileToken: string
}

/**
 * Call the submitGuardianApplication mutation via the shared gqlClient.
 * Returns a typed result union; never throws (network errors surface as
 * InternalError).
 */
export async function submitGuardianApplication(
  input: SubmitGuardianApplicationInput,
): Promise<GuardianApplicationResult> {
  try {
    const data = await gqlClient.request<{
      submitGuardianApplication: GuardianApplicationResultRaw
    }>(SUBMIT_GUARDIAN_APPLICATION_MUTATION, { input })

    const result = data.submitGuardianApplication
    if (result.__typename === 'GuardianApplicationSuccess') {
      return { ok: true, applicationId: result.applicationId }
    }
    return { ok: false, code: result.code, message: result.message }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error'
    return { ok: false, code: 'InternalError', message }
  }
}
