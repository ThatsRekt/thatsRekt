/**
 * Guardian application write path.
 *
 * Anonymous users (no wallet required) submit a guardian application form.
 * The mutation validates input server-side, verifies a Cloudflare Turnstile
 * token, then inserts exactly one row into `guardian_applications` in the
 * `thatsrekt_meta` database.
 *
 * Security surface (enforced here — never trust the client):
 * - Justification: 50–1500 chars.
 * - Primary contact: required; type in {telegram, email, signal, twitter};
 *   per-type format validation; value ≤128 chars.
 * - Extra contacts: ≤2 extras (3 total). Same per-type validation.
 * - Honeypot: non-empty → silently reject (pretend success, insert nothing).
 * - Turnstile: server-side siteverify; dev/CI uses Cloudflare test keys.
 *
 * The nginx /graphql rate-limit is inherited — no extra rate-limit code here.
 *
 * Pattern mirrors comments.ts: discriminated-union result, Zod-validated
 * input schema, metaPool for DB, no IO in validation helpers.
 */
import { z } from 'zod'
import { createHash } from 'node:crypto'

import { metaPool } from './db.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JUSTIFICATION_MIN = 50
const JUSTIFICATION_MAX = 1500
const CONTACT_VALUE_MAX = 128
const EXTRA_CONTACTS_MAX = 2   // primary + extras ≤ 3 total

// Cloudflare Turnstile siteverify endpoint.
const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

// Turnstile secret from env. In dev/CI this MUST be one of the Cloudflare
// documented test secrets so the real siteverify endpoint returns a
// predictable result without prod keys:
//   Always-pass secret: 1x0000000000000000000000000000000AA
//   Always-fail secret: 2x0000000000000000000000000000000AA
// Prod secrets are injected at deploy time (slice #178) — do NOT hardcode them.
const DEFAULT_TURNSTILE_SECRET =
  process.env.TURNSTILE_SECRET ?? '1x0000000000000000000000000000000AA'

// IP hashing: sha256 of the raw IP, truncated to 16 hex chars. Enough for
// abuse forensics; not reversible to the original address.
const hashIp = (ip: string): string =>
  createHash('sha256').update(ip).digest('hex').slice(0, 16)

// ---------------------------------------------------------------------------
// Contact type constants and per-type validators (pure)
// ---------------------------------------------------------------------------

const CONTACT_TYPES = ['telegram', 'email', 'signal', 'twitter'] as const
type ContactType = (typeof CONTACT_TYPES)[number]

const isContactType = (s: string): s is ContactType =>
  (CONTACT_TYPES as readonly string[]).includes(s)

/** Telegram: @handle, 1–64 chars after @, alphanumeric + underscore. */
const TELEGRAM_RE = /^@[A-Za-z0-9_]{1,64}$/

/** Twitter: @handle, 1–50 chars after @, alphanumeric + underscore. */
const TWITTER_RE = /^@[A-Za-z0-9_]{1,50}$/

/** Signal: E.164 phone number, e.g. +15555550100. */
const SIGNAL_RE = /^\+[1-9]\d{6,14}$/

/** Email: basic sanity check — localpart@domain.tld, no spaces. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Validate a contact value for a given type. Pure — no IO.
 * Checks length cap and per-type format.
 */
const validateContactValue = (type: ContactType, value: string): boolean => {
  if (value.length === 0 || value.length > CONTACT_VALUE_MAX) return false
  switch (type) {
    case 'telegram':
      return TELEGRAM_RE.test(value)
    case 'twitter':
      return TWITTER_RE.test(value)
    case 'signal':
      return SIGNAL_RE.test(value)
    case 'email':
      return EMAIL_RE.test(value)
  }
}

// ---------------------------------------------------------------------------
// Zod schemas — loose structural parse; semantic validation happens in code
// ---------------------------------------------------------------------------

// We use a loose string for `type` here so that unknown contact types
// (e.g. "discord") surface as `InvalidContact` in application code rather
// than as a generic Zod parse error that we'd have to map opaquely.
const RawContactSchema = z.object({
  type: z.string(),
  value: z.string(),
})
type RawContact = z.infer<typeof RawContactSchema>

const RawGuardianInputSchema = z.object({
  justification: z.string(),
  primaryContact: RawContactSchema.nullable(),
  extraContacts: z.array(RawContactSchema).nullable(),
  honeypot: z.string(),
  turnstileToken: z.string(),
  sourceIp: z.string().optional(),
})
type RawGuardianInput = z.infer<typeof RawGuardianInputSchema>

// The validated (semantically correct) internal type after application-layer checks.
type ValidatedContact = { type: ContactType; value: string }

// ---------------------------------------------------------------------------
// Result union
// ---------------------------------------------------------------------------

export type GuardianApplicationErrorCode =
  | 'JustificationTooShort'
  | 'JustificationTooLong'
  | 'InvalidContact'
  | 'TooManyContacts'
  | 'TurnstileFailed'
  | 'InternalError'

export type GuardianApplicationResult =
  | { __typename: 'GuardianApplicationSuccess'; applicationId: string }
  | {
      __typename: 'GuardianApplicationError'
      code: GuardianApplicationErrorCode
      message: string
    }

type ErrorVariant = Extract<GuardianApplicationResult, { __typename: 'GuardianApplicationError' }>

const errorOf = (code: GuardianApplicationErrorCode, message: string): ErrorVariant => ({
  __typename: 'GuardianApplicationError',
  code,
  message,
})

const success = (applicationId: string): GuardianApplicationResult => ({
  __typename: 'GuardianApplicationSuccess',
  applicationId,
})

// ---------------------------------------------------------------------------
// Turnstile verification
//
// Hits the real Cloudflare siteverify endpoint. In dev/CI, callers inject
// the always-pass test secret (1x0000000000000000000000000000000AA) and use
// the matching always-pass test token (1x00000000000000000000AA). For
// reject paths, callers inject the always-fail secret
// (2x0000000000000000000000000000000AA) with the always-fail token
// (2x00000000000000000000AB). This exercises the real HTTP contract without
// prod keys.
//
// Never throws — network failures produce false (reject submission safely).
// ---------------------------------------------------------------------------

const TurnstileResponseSchema = z.object({
  success: z.boolean(),
  'error-codes': z.array(z.string()).optional(),
})

/**
 * Factory that returns a Turnstile verifier bound to a specific secret.
 * The default export below is bound to DEFAULT_TURNSTILE_SECRET.
 * Tests can call this directly to inject test secrets.
 */
export const makeTurnstileVerifier = (secret: string) =>
  async (token: string): Promise<boolean> => {
    if (!token) return false
    try {
      const body = new URLSearchParams({ secret, response: token })
      const res = await fetch(TURNSTILE_SITEVERIFY_URL, { method: 'POST', body })
      if (!res.ok) {
        console.error('[guardian] Turnstile siteverify HTTP error:', res.status)
        return false
      }
      const json: unknown = await res.json()
      const parsed = TurnstileResponseSchema.safeParse(json)
      if (!parsed.success) {
        console.error('[guardian] Turnstile response schema mismatch:', parsed.error.flatten())
        return false
      }
      return parsed.data.success
    } catch (err) {
      console.error('[guardian] Turnstile siteverify error:', err)
      return false
    }
  }

// Default verifier uses the env-configured secret.
const defaultVerifyTurnstile = makeTurnstileVerifier(DEFAULT_TURNSTILE_SECRET)

// ---------------------------------------------------------------------------
// Dependency injection interface — keeps the resolver testable
// ---------------------------------------------------------------------------

export interface GuardianDeps {
  /**
   * Turnstile verifier. Defaults to the env-configured secret.
   * Override in tests to use the Cloudflare test secrets.
   */
  verifyTurnstile?: (token: string) => Promise<boolean>
  /**
   * Postgres pool to use for DB writes. Defaults to the module-level
   * metaPool singleton. Override in integration/e2e tests to inject a
   * test-scoped pool without relying on process.env.META_DB_URL.
   */
  pool?: import('pg').Pool
}

// ---------------------------------------------------------------------------
// Pure validation helpers
// ---------------------------------------------------------------------------

const validateJustification = (text: string): ErrorVariant | null => {
  if (text.length < JUSTIFICATION_MIN) {
    return errorOf(
      'JustificationTooShort',
      `Justification must be at least ${JUSTIFICATION_MIN} characters`,
    )
  }
  if (text.length > JUSTIFICATION_MAX) {
    return errorOf(
      'JustificationTooLong',
      `Justification must be at most ${JUSTIFICATION_MAX} characters`,
    )
  }
  return null
}

/**
 * Validate a raw contact object. Returns an error variant on any failure:
 * - unknown type → InvalidContact
 * - empty or over-length value → InvalidContact
 * - format mismatch per type → InvalidContact
 */
const validateRawContact = (
  raw: RawContact,
  label: string,
): { contact: ValidatedContact } | ErrorVariant => {
  if (!isContactType(raw.type)) {
    return errorOf(
      'InvalidContact',
      `${label}: unknown contact type "${raw.type}". Must be one of: ${CONTACT_TYPES.join(', ')}`,
    )
  }
  if (!validateContactValue(raw.type, raw.value)) {
    return errorOf(
      'InvalidContact',
      `${label}: invalid value for type "${raw.type}"`,
    )
  }
  return { contact: { type: raw.type, value: raw.value } }
}

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface ApplicationDbRow {
  id: string
  created_at: Date
  primary_contact_type: string
  primary_contact_value: string
  extra_contacts: ValidatedContact[] | null
  justification: string
  forwarded_at: Date | null
  forwarded_message_id: string | null
  source_ip_hash: string | null
}

// ---------------------------------------------------------------------------
// Main resolver function — exported for tests and GraphQL wiring
// ---------------------------------------------------------------------------

/**
 * Submit a guardian application.
 *
 * Validation order (fail fast):
 * 1. Structural parse with Zod (shape safety)
 * 2. Honeypot check (silently succeed without inserting)
 * 3. Justification length
 * 4. Primary contact presence + type + format
 * 5. Extra contacts count + type + format
 * 6. Turnstile verification (network call)
 * 7. DB insert
 */
export const submitGuardianApplication = async (
  rawInput: unknown,
  deps: GuardianDeps = {},
): Promise<GuardianApplicationResult> => {
  const verifyTurnstile = deps.verifyTurnstile ?? defaultVerifyTurnstile
  const pool = deps.pool ?? metaPool

  // 1. Structural parse — catches missing fields / wrong JS types.
  //    We use a loose schema so semantic errors (wrong contact type, bad
  //    email format) surface with our own descriptive error codes below.
  const parsed = RawGuardianInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    const field = firstIssue?.path.join('.') ?? 'input'
    const msg = firstIssue?.message ?? 'Invalid input'
    return errorOf('InternalError', `Schema validation failed on ${field}: ${msg}`)
  }
  const input: RawGuardianInput = parsed.data

  // 2. Honeypot — silently succeed, insert nothing.
  if (input.honeypot !== '') {
    return { __typename: 'GuardianApplicationSuccess', applicationId: '0' }
  }

  // 3. Justification
  const justErr = validateJustification(input.justification)
  if (justErr) return justErr

  // 4. Primary contact
  if (!input.primaryContact) {
    return errorOf('InvalidContact', 'Primary contact is required')
  }
  const primaryResult = validateRawContact(input.primaryContact, 'Primary contact')
  if ('__typename' in primaryResult) return primaryResult
  const primaryContact = primaryResult.contact

  // 5. Extra contacts
  const rawExtras = input.extraContacts ?? []
  if (rawExtras.length > EXTRA_CONTACTS_MAX) {
    return errorOf(
      'TooManyContacts',
      `At most ${EXTRA_CONTACTS_MAX} extra contacts allowed (3 total including primary)`,
    )
  }
  const extras: ValidatedContact[] = []
  for (const [i, raw] of rawExtras.entries()) {
    const result = validateRawContact(raw, `Extra contact ${i + 1}`)
    if ('__typename' in result) return result
    extras.push(result.contact)
  }

  // 6. Turnstile
  const turnstileOk = await verifyTurnstile(input.turnstileToken)
  if (!turnstileOk) {
    return errorOf('TurnstileFailed', 'Turnstile verification failed, please try again')
  }

  // 7. Insert
  const ipHash = input.sourceIp ? hashIp(input.sourceIp) : null
  const extrasJson = extras.length > 0 ? JSON.stringify(extras) : null

  let row: ApplicationDbRow
  try {
    const result = await pool.query<ApplicationDbRow>(
      `INSERT INTO guardian_applications (
         primary_contact_type,
         primary_contact_value,
         extra_contacts,
         justification,
         source_ip_hash
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING
         id::text,
         created_at,
         primary_contact_type,
         primary_contact_value,
         extra_contacts,
         justification,
         forwarded_at,
         forwarded_message_id,
         source_ip_hash`,
      [
        primaryContact.type,
        primaryContact.value,
        extrasJson,
        input.justification,
        ipHash,
      ],
    )
    if (result.rows.length === 0) {
      return errorOf('InternalError', 'Insert returned no rows')
    }
    row = result.rows[0]!
  } catch (err) {
    console.error('[guardian] insert failed:', err)
    return errorOf('InternalError', 'Failed to persist application')
  }

  return success(row.id)
}

// ---------------------------------------------------------------------------
// GraphQL type definitions
// ---------------------------------------------------------------------------

export const guardianTypeDefs = /* GraphQL */ `
  """A single guardian application contact method."""
  input GuardianContactInput {
    """One of: telegram, email, signal, twitter."""
    type: String!
    """Contact value, e.g. @handle, user@example.com, +15555550100."""
    value: String!
  }

  type GuardianApplicationSuccess {
    """Opaque ID of the newly created application row."""
    applicationId: ID!
  }

  """
  Error returned when \`submitGuardianApplication\` fails validation.
  \`code\` is one of: JustificationTooShort, JustificationTooLong,
  InvalidContact, TooManyContacts, TurnstileFailed, InternalError.
  """
  type GuardianApplicationError {
    code: String!
    message: String!
  }

  union GuardianApplicationResult = GuardianApplicationSuccess | GuardianApplicationError

  input SubmitGuardianApplicationInput {
    """
    Motivation and qualifications. 50 chars minimum, 1500 chars maximum.
    """
    justification: String!
    """Primary contact channel. Required."""
    primaryContact: GuardianContactInput!
    """Up to 2 additional contact channels (3 total including primary)."""
    extraContacts: [GuardianContactInput!]
    """
    Honeypot — must be left empty by real users. Non-empty submissions are
    silently rejected (pretend success, insert nothing).
    """
    honeypot: String!
    """Cloudflare Turnstile challenge response token from the client."""
    turnstileToken: String!
  }

  extend type Mutation {
    """
    Submit a guardian application. Anonymous — no wallet required.
    Server-side validated. Turnstile required.
    """
    submitGuardianApplication(input: SubmitGuardianApplicationInput!): GuardianApplicationResult!
  }
`

// ---------------------------------------------------------------------------
// GraphQL resolver wiring
// ---------------------------------------------------------------------------

export const buildGuardianResolvers = () => ({
  Mutation: {
    submitGuardianApplication: (
      _root: unknown,
      args: {
        input: {
          justification: string
          primaryContact: { type: string; value: string }
          extraContacts?: Array<{ type: string; value: string }> | null
          honeypot: string
          turnstileToken: string
        }
      },
      context: { request?: { headers?: { get?: (key: string) => string | null } } },
    ) => {
      // Extract source IP from forwarded header — set by nginx.
      const forwarded =
        context?.request?.headers?.get?.('x-forwarded-for') ?? null
      const sourceIp = forwarded ? forwarded.split(',')[0]?.trim() : undefined

      return submitGuardianApplication(
        {
          ...args.input,
          extraContacts: args.input.extraContacts ?? null,
          sourceIp,
        },
        // Production path uses the default env-configured secret.
        {},
      )
    },
  },
  GuardianApplicationResult: {
    __resolveType: (obj: GuardianApplicationResult) => obj.__typename,
  },
})
