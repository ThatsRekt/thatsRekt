/**
 * Off-chain guardian comments — full validation pipeline + resolvers.
 *
 * Comments are signed via EIP-712 typed data by the guardian's wallet.
 * The server reconstructs the canonical typed-data payload, recovers
 * the address with viem's `recoverTypedDataAddress`, and asserts it
 * matches the claimed signer. Only whitelisted (per the on-chain
 * registry on the comment's chain) guardians can post; only the
 * original signer can edit or delete.
 *
 * The EIP-712 domain binds each signature to a specific chain
 * (`chainId` + `verifyingContract` = the registry proxy on that
 * chain), so a signature collected for one chain can't be replayed on
 * another. Wallets render parsed fields (postId/body/signedAt) instead
 * of raw text, defending against cross-site `personal_sign` phishing.
 *
 * No version history. Edits overwrite. Deletes are hard. Per the
 * operator's call: "no need to overengineer this."
 *
 * Storage: shared `thatsrekt_meta` Postgres database, single `comments`
 * table. See `db.ts` for the schema.
 */
import {
  hashTypedData,
  recoverTypedDataAddress,
  type TypedDataDomain,
} from 'viem'
import type { Executor } from '@graphql-tools/utils'
import type { ExecutionResult } from 'graphql'
import { parse } from 'graphql'

import { metaPool } from './db.js'
import type { ChainEntry } from './chains.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Public-facing GraphQL Comment shape. */
export interface CommentRow {
  id: string
  postId: string
  chainSlug: string
  signer: string
  body: string
  createdAt: string
  lastEditedAt: string | null
  signedAt: string
  signature: string
  messageHash: string
}

/** Discriminated union returned by every mutation. */
export type SubmitCommentResult =
  | { __typename: 'SubmitCommentSuccess'; comment: CommentRow }
  | { __typename: 'SubmitCommentError'; code: ErrorCode; message: string }

export type DeleteCommentResult =
  | { __typename: 'DeleteCommentSuccess'; commentId: string }
  | { __typename: 'SubmitCommentError'; code: ErrorCode; message: string }

export type ErrorCode =
  | 'NotWhitelisted'
  | 'InvalidSignature'
  | 'InvalidTimestamp'
  | 'PostNotFound'
  | 'RateLimited'
  | 'DuplicateSubmission'
  | 'BodyTooLong'
  | 'BodyTooShort'
  | 'NotCommentOwner'
  | 'CommentNotFound'
  | 'InternalError'

export interface SubmitCommentInput {
  postId: string
  body: string
  signer: string
  signature: string
  signedAt: string
}

export interface EditCommentInput {
  commentId: string
  postId: string
  newBody: string
  signer: string
  signature: string
  signedAt: string
}

export interface DeleteCommentInput {
  commentId: string
  postId: string
  signer: string
  signature: string
  signedAt: string
}

/**
 * Per-chain executor lookup. Comments resolvers are bound to the same
 * executor pool as the cross-chain `posts(...)` resolver, but selected
 * by chain_slug instead of fanned out.
 */
export type ChainExecutorLookup = (chainSlug: string) => Executor | null

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BODY_MIN = 1
const BODY_MAX = 1000
const TIME_WINDOW_MS = 5 * 60 * 1000 // ±5 minutes
const RATE_LIMIT_MS = 5_000           // 1 create per signer per 5 seconds
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const SIGNATURE_RE = /^0x[a-fA-F0-9]{130}$/
const COMMENT_ID_RE = /^\d+$/

// EIP-712 typed-data spec. Frozen so neither this module nor a future
// extension can mutate the field order; reordering would invalidate every
// previously-issued signature.
export const COMMENT_TYPES = Object.freeze({
  CreateComment: [
    { name: 'postId', type: 'string' },
    { name: 'body', type: 'string' },
    { name: 'signedAt', type: 'string' },
  ],
  EditComment: [
    { name: 'commentId', type: 'uint256' },
    { name: 'postId', type: 'string' },
    { name: 'newBody', type: 'string' },
    { name: 'signedAt', type: 'string' },
  ],
  DeleteComment: [
    { name: 'commentId', type: 'uint256' },
    { name: 'postId', type: 'string' },
    { name: 'signedAt', type: 'string' },
  ],
}) satisfies Record<string, ReadonlyArray<{ name: string; type: string }>>

const DOMAIN_NAME = 'thatsRekt'
const DOMAIN_VERSION = '1'

// ---------------------------------------------------------------------------
// In-memory rate limiter
// ---------------------------------------------------------------------------
//
// Tiny — single-process Map<lowercased signer, lastCreateMs>. Rate
// limiting only applies to creates (edits/deletes are bounded by the
// existing comment row, which can't be replayed). Periodic cleanup
// every 10 minutes drops entries older than an hour. No need for Redis
// at this scale.
const rateLimitMap = new Map<string, number>()

const RATE_LIMIT_GC_INTERVAL_MS = 10 * 60 * 1000
const RATE_LIMIT_GC_TTL_MS = 60 * 60 * 1000

let gcTimer: ReturnType<typeof setInterval> | null = null

/** Start the periodic GC. Idempotent. */
export function startRateLimitGc(): void {
  if (gcTimer) return
  gcTimer = setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_GC_TTL_MS
    for (const [k, v] of rateLimitMap) {
      if (v < cutoff) rateLimitMap.delete(k)
    }
    // Same TTL applies to the failed-whitelist cache.
    const fwCutoff = Date.now() - FAILED_WHITELIST_TTL_GC_MS
    for (const [k, v] of failedWhitelistMap) {
      if (v < fwCutoff) failedWhitelistMap.delete(k)
    }
  }, RATE_LIMIT_GC_INTERVAL_MS)
  // Don't keep the event loop alive just for the GC.
  if (typeof gcTimer.unref === 'function') gcTimer.unref()
}

/** Stop the GC (used by tests to avoid hanging). */
export function stopRateLimitGc(): void {
  if (gcTimer) {
    clearInterval(gcTimer)
    gcTimer = null
  }
}

/** Test/debug: reset rate-limit state. */
export function resetRateLimit(): void {
  rateLimitMap.clear()
}

// ---------------------------------------------------------------------------
// Failed-whitelist short-circuit cache (audit M-3)
// ---------------------------------------------------------------------------
//
// An attacker can spam our gateway with fresh keypairs that will never
// be whitelisted; each rejection still costs us a round-trip to the
// upstream squid. We hold a tiny in-memory map of recently-failed
// signers (lowercased address → ms ts of last failure) and short-circuit
// to `NotWhitelisted` for repeat hits inside `FAILED_WHITELIST_WINDOW_MS`.
// On a successful whitelist check we evict the entry (in case the
// signer was JUST whitelisted). The map is GC'd alongside rateLimitMap.
const failedWhitelistMap = new Map<string, number>()
const FAILED_WHITELIST_WINDOW_MS = 60_000          // 1 minute short-circuit
const FAILED_WHITELIST_TTL_GC_MS = 60 * 60 * 1000  // GC entries older than 1h

/** Test/debug: reset failed-whitelist state. */
export function resetFailedWhitelist(): void {
  failedWhitelistMap.clear()
}

// ---------------------------------------------------------------------------
// EIP-712 typed-data construction
// ---------------------------------------------------------------------------
//
// Three op variants — create / edit / delete. The exact typed-data
// payload is reconstructed server-side from input fields and recovered
// with `recoverTypedDataAddress`. Any drift between client and server
// builders (or a wrong domain) is rejected as `InvalidSignature`.

/** EIP-712 domain for a chain. Fields are bound to the registry proxy
 *  address on that chain so signatures can't be replayed cross-chain. */
export const buildDomain = (chain: ChainEntry & { registryAddress: `0x${string}` }): TypedDataDomain => ({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  chainId: chain.chainId,
  verifyingContract: chain.registryAddress,
})

export interface CreateTypedData {
  domain: TypedDataDomain
  types: typeof COMMENT_TYPES
  primaryType: 'CreateComment'
  message: { postId: string; body: string; signedAt: string }
}

export interface EditTypedData {
  domain: TypedDataDomain
  types: typeof COMMENT_TYPES
  primaryType: 'EditComment'
  message: { commentId: bigint; postId: string; newBody: string; signedAt: string }
}

export interface DeleteTypedData {
  domain: TypedDataDomain
  types: typeof COMMENT_TYPES
  primaryType: 'DeleteComment'
  message: { commentId: bigint; postId: string; signedAt: string }
}

export const buildCreateTypedData = (params: {
  domain: TypedDataDomain
  postId: string
  body: string
  signedAt: string
}): CreateTypedData => ({
  domain: params.domain,
  types: COMMENT_TYPES,
  primaryType: 'CreateComment',
  message: {
    postId: params.postId,
    body: params.body,
    signedAt: params.signedAt,
  },
})

export const buildEditTypedData = (params: {
  domain: TypedDataDomain
  commentId: string
  postId: string
  newBody: string
  signedAt: string
}): EditTypedData => ({
  domain: params.domain,
  types: COMMENT_TYPES,
  primaryType: 'EditComment',
  message: {
    commentId: BigInt(params.commentId),
    postId: params.postId,
    newBody: params.newBody,
    signedAt: params.signedAt,
  },
})

export const buildDeleteTypedData = (params: {
  domain: TypedDataDomain
  commentId: string
  postId: string
  signedAt: string
}): DeleteTypedData => ({
  domain: params.domain,
  types: COMMENT_TYPES,
  primaryType: 'DeleteComment',
  message: {
    commentId: BigInt(params.commentId),
    postId: params.postId,
    signedAt: params.signedAt,
  },
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Split a composite `<chainSlug>-<onchainPostId>` into its components.
 * Chain slugs may contain hyphens (e.g. `base-sepolia`), so we try the
 * provided slugs as prefixes longest-first to disambiguate. Returns null
 * if no enabled chain matches.
 */
export const parsePostId = (
  composite: string,
  chains: readonly ChainEntry[],
): { chainSlug: string; onchainId: string } | null => {
  // Sort by descending length so `base-sepolia-1` matches `base-sepolia`
  // before `base`.
  const slugs = [...chains].map((c) => c.slug).sort((a, b) => b.length - a.length)
  for (const slug of slugs) {
    const prefix = `${slug}-`
    if (composite.startsWith(prefix)) {
      const onchainId = composite.slice(prefix.length)
      // The onchain id must be a non-empty numeric string.
      if (onchainId.length > 0 && /^\d+$/.test(onchainId)) {
        return { chainSlug: slug, onchainId }
      }
    }
  }
  return null
}

/**
 * Look up the chain entry for a given slug, narrowing the type when the
 * chain has a deployed registry. Returns null otherwise — a chain
 * without a registry can't accept comments because we have no
 * `verifyingContract` to bind the EIP-712 domain to.
 */
export const chainWithRegistry = (
  chains: readonly ChainEntry[],
  slug: string,
): (ChainEntry & { registryAddress: `0x${string}` }) | null => {
  const entry = chains.find((c) => c.slug === slug)
  if (!entry || !entry.registryAddress) return null
  return entry as ChainEntry & { registryAddress: `0x${string}` }
}

/**
 * Shared error variant. Lives in both SubmitCommentResult and
 * DeleteCommentResult unions, so the helper returns the narrow shape
 * directly — callers widen at the return site.
 */
type ErrorVariant = { __typename: 'SubmitCommentError'; code: ErrorCode; message: string }

const errorOf = (code: ErrorCode, message: string): ErrorVariant => ({
  __typename: 'SubmitCommentError',
  code,
  message,
})

const successOf = (comment: CommentRow): SubmitCommentResult => ({
  __typename: 'SubmitCommentSuccess',
  comment,
})

const isAddressString = (s: string): boolean => ADDRESS_RE.test(s)
const isSignatureString = (s: string): boolean => SIGNATURE_RE.test(s)
const isCommentIdString = (s: string): boolean => COMMENT_ID_RE.test(s)

/** Normalize an address to lowercase 0x-prefixed hex. */
const normalizeAddress = (s: string): string => s.toLowerCase()

/** Equality on EVM addresses, case-insensitive. */
const addressesEqual = (a: string, b: string): boolean =>
  normalizeAddress(a) === normalizeAddress(b)

// ---------------------------------------------------------------------------
// Validation primitives — pure
// ---------------------------------------------------------------------------

/**
 * Schema-level checks that apply to every mutation input. Returns null
 * if valid, a result-shaped error otherwise. Pure — no IO.
 */
const validateCommonShape = (params: {
  signer: string
  signature: string
  signedAt: string
}): ErrorVariant | null => {
  if (!isAddressString(params.signer)) {
    return errorOf('InvalidSignature', `Invalid signer address: ${params.signer}`)
  }
  if (!isSignatureString(params.signature)) {
    return errorOf('InvalidSignature', 'Invalid signature format')
  }
  const ts = Date.parse(params.signedAt)
  if (Number.isNaN(ts)) {
    return errorOf('InvalidTimestamp', `Unparseable signedAt: ${params.signedAt}`)
  }
  const skew = Math.abs(Date.now() - ts)
  if (skew > TIME_WINDOW_MS) {
    return errorOf(
      'InvalidTimestamp',
      `signedAt is ${Math.round(skew / 1000)}s outside the ±5min window`,
    )
  }
  return null
}

const validateBody = (body: string): ErrorVariant | null => {
  if (body.length < BODY_MIN) return errorOf('BodyTooShort', 'Body must be at least 1 character')
  if (body.length > BODY_MAX) return errorOf('BodyTooLong', `Body must be at most ${BODY_MAX} characters`)
  return null
}

/**
 * Recover the signing address from EIP-712 typed data + signature, and
 * assert it matches the claimed signer. Returns the recovered address on
 * success or a result-shaped error on mismatch / recovery failure.
 */
export const verifyTypedDataSignature = async <
  TD extends CreateTypedData | EditTypedData | DeleteTypedData,
>(params: {
  typedData: TD
  signature: string
  signer: string
}): Promise<{ ok: true; recovered: string } | ErrorVariant> => {
  let recovered: string
  try {
    recovered = await recoverTypedDataAddress({
      domain: params.typedData.domain,
      // viem types are tightly coupled to the const-asserted shape; the
      // generic relaxation here is safe because COMMENT_TYPES + the
      // discriminated union of typed-data builders enforce well-typed
      // inputs at every call site.
      types: params.typedData.types as Record<string, ReadonlyArray<{ name: string; type: string }>>,
      primaryType: params.typedData.primaryType,
      message: params.typedData.message as Record<string, unknown>,
      signature: params.signature as `0x${string}`,
    })
  } catch (err) {
    return errorOf('InvalidSignature', `Signature recovery failed: ${(err as Error).message}`)
  }
  if (!addressesEqual(recovered, params.signer)) {
    return errorOf(
      'InvalidSignature',
      `Recovered ${normalizeAddress(recovered)} ≠ claimed ${normalizeAddress(params.signer)}`,
    )
  }
  return { ok: true, recovered: normalizeAddress(recovered) }
}

/** Hash an EIP-712 typed-data payload. Stored alongside the row for audit. */
const typedDataHash = (
  td: CreateTypedData | EditTypedData | DeleteTypedData,
): `0x${string}` =>
  hashTypedData({
    domain: td.domain,
    types: td.types as Record<string, ReadonlyArray<{ name: string; type: string }>>,
    primaryType: td.primaryType,
    message: td.message as Record<string, unknown>,
  })

// ---------------------------------------------------------------------------
// Per-chain whitelist + post-existence checks (Subsquid GraphQL)
// ---------------------------------------------------------------------------

const WHITELIST_QUERY = /* GraphQL */ `
  query CheckWhitelist($id: String!) {
    whitelisterById(id: $id) {
      id
      isCurrentlyWhitelisted
    }
  }
`

const POST_QUERY = /* GraphQL */ `
  query CheckPost($id: String!) {
    postById(id: $id) {
      id
      purged
    }
  }
`

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Returns true iff the address is a CURRENTLY whitelisted guardian on the chain. */
export const isWhitelisted = async (
  executor: Executor,
  address: string,
): Promise<boolean> => {
  const result = (await executor({
    document: parse(WHITELIST_QUERY),
    variables: { id: normalizeAddress(address) },
    context: {},
  })) as ExecutionResult
  if (result.errors?.length) {
    console.error('[comments] whitelist check returned errors:', result.errors)
    return false
  }
  const data = result.data
  if (!isPlainObject(data)) return false
  const w = data.whitelisterById
  if (!isPlainObject(w)) return false
  return w.isCurrentlyWhitelisted === true
}

/**
 * Whitelist gate with the failed-whitelist short-circuit cache (audit
 * M-3). On a sub-FAILED_WHITELIST_WINDOW_MS rejection we skip the
 * upstream round-trip entirely.
 *
 * - Returns true: signer is whitelisted; cache entry (if any) is evicted.
 * - Returns false: signer is not whitelisted; cache entry is recorded
 *   with the current timestamp so future hits short-circuit.
 */
const isWhitelistedCached = async (
  executor: Executor,
  signer: string,
): Promise<boolean> => {
  const key = normalizeAddress(signer)
  const lastFail = failedWhitelistMap.get(key)
  if (lastFail !== undefined && Date.now() - lastFail < FAILED_WHITELIST_WINDOW_MS) {
    return false
  }
  const ok = await isWhitelisted(executor, signer)
  if (ok) {
    failedWhitelistMap.delete(key)
  } else {
    failedWhitelistMap.set(key, Date.now())
  }
  return ok
}

/**
 * Returns true iff the on-chain post exists AND has not been purged by
 * governance. Treating purged posts as not-found blocks every
 * downstream mutation (create / edit / delete) and lets us return the
 * same `[]` for the read path so we don't reintroduce content
 * governance just scrubbed. (audit M-1)
 */
export const postExists = async (
  executor: Executor,
  onchainId: string,
): Promise<boolean> => {
  const result = (await executor({
    document: parse(POST_QUERY),
    variables: { id: onchainId },
    context: {},
  })) as ExecutionResult
  if (result.errors?.length) {
    console.error('[comments] post check returned errors:', result.errors)
    return false
  }
  const data = result.data
  if (!isPlainObject(data)) return false
  const p = data.postById
  if (!isPlainObject(p) || typeof p.id !== 'string') return false
  // Coalesce undefined → false: tolerates upstreams that haven't applied
  // the purge migration yet. Block iff the upstream explicitly says
  // purged===true.
  if (p.purged === true) return false
  return true
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

interface CommentDbRow {
  id: string                       // BIGSERIAL — pg returns BIGINT as string
  post_id: string
  chain_slug: string
  signer_address: string
  body: string
  signature: string
  signed_at: Date
  created_at: Date
  last_edited_at: Date | null
  message_hash: string
}

const rowToComment = (row: CommentDbRow): CommentRow => ({
  id: row.id,
  postId: row.post_id,
  chainSlug: row.chain_slug,
  signer: row.signer_address,
  body: row.body,
  createdAt: row.created_at.toISOString(),
  lastEditedAt: row.last_edited_at ? row.last_edited_at.toISOString() : null,
  signedAt: row.signed_at.toISOString(),
  signature: row.signature,
  messageHash: row.message_hash,
})

/**
 * Type-narrowing predicate for the pg unique-violation error. The pg
 * driver attaches a `code` field to the thrown Error; SQLSTATE
 * 23505 == unique_violation. We use this in the create path to convert
 * the race-induced unique constraint hit into `DuplicateSubmission`.
 */
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'

// ---------------------------------------------------------------------------
// Public read resolvers
// ---------------------------------------------------------------------------

/**
 * List comments for a post. Returns `[]` when the post has been purged
 * by governance (audit M-1) — same policy as create/edit/delete: the
 * gateway does not surface comments tied to scrubbed content.
 *
 * If the post's chain is unknown, or the chain has no registered
 * executor, we also return `[]`. We don't surface a partial answer
 * for content we can't authoritatively decide on.
 */
export const listComments = async (
  postId: string,
  limit: number,
  offset: number,
  deps: ResolverDeps,
): Promise<CommentRow[]> => {
  const parsed = parsePostId(postId, deps.chains)
  if (!parsed) return []
  const executor = deps.getExecutor(parsed.chainSlug)
  if (!executor) return []
  const visible = await postExists(executor, parsed.onchainId)
  if (!visible) return []

  // Defensive: clamp pagination args. The schema sets defaults but the
  // resolver shouldn't trust them blindly.
  const safeLimit = Math.max(1, Math.min(200, limit))
  const safeOffset = Math.max(0, offset)
  const { rows } = await metaPool.query<CommentDbRow>(
    `SELECT id::text, post_id, chain_slug, signer_address, body, signature,
            signed_at, created_at, last_edited_at, message_hash
       FROM comments
       WHERE post_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
    [postId, safeLimit, safeOffset],
  )
  return rows.map(rowToComment)
}

/**
 * Comment count for a post. Mirrors `listComments` purge handling: a
 * purged post reports 0 even if rows still exist in the DB. Keeps the
 * UI's count chip consistent with what `comments(...)` actually returns.
 */
export const commentCount = async (
  postId: string,
  deps: ResolverDeps,
): Promise<number> => {
  const parsed = parsePostId(postId, deps.chains)
  if (!parsed) return 0
  const executor = deps.getExecutor(parsed.chainSlug)
  if (!executor) return 0
  const visible = await postExists(executor, parsed.onchainId)
  if (!visible) return 0

  const { rows } = await metaPool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM comments WHERE post_id = $1`,
    [postId],
  )
  if (rows.length === 0) return 0
  const n = Number.parseInt(rows[0]!.count, 10)
  return Number.isFinite(n) ? n : 0
}

// ---------------------------------------------------------------------------
// Mutation resolvers
// ---------------------------------------------------------------------------

export interface ResolverDeps {
  chains: readonly ChainEntry[]
  /** Maps a chain slug to its upstream squid executor. */
  getExecutor: ChainExecutorLookup
}

export const createComment = async (
  input: SubmitCommentInput,
  deps: ResolverDeps,
): Promise<SubmitCommentResult> => {
  // 1. Schema-level shape checks
  const shapeErr = validateCommonShape(input)
  if (shapeErr) return shapeErr
  const bodyErr = validateBody(input.body)
  if (bodyErr) return bodyErr

  // 2. Resolve chain slug from composite postId + look up the registry
  //    (we need the `verifyingContract` for the EIP-712 domain).
  const parsed = parsePostId(input.postId, deps.chains)
  if (!parsed) {
    return errorOf('PostNotFound', `Unknown chain in postId: ${input.postId}`)
  }
  const chain = chainWithRegistry(deps.chains, parsed.chainSlug)
  if (!chain) {
    return errorOf('PostNotFound', `Chain ${parsed.chainSlug} has no registered comment surface`)
  }
  const executor = deps.getExecutor(parsed.chainSlug)
  if (!executor) {
    return errorOf('PostNotFound', `Chain ${parsed.chainSlug} not enabled`)
  }

  // 3. EIP-712 signature recovery on the canonical typed data
  const typedData = buildCreateTypedData({
    domain: buildDomain(chain),
    postId: input.postId,
    body: input.body,
    signedAt: input.signedAt,
  })
  const sig = await verifyTypedDataSignature({
    typedData,
    signature: input.signature,
    signer: input.signer,
  })
  if (!('ok' in sig)) return sig
  const signer = sig.recovered // lowercased

  // 4. Whitelist gate (with failed-whitelist short-circuit)
  const allowed = await isWhitelistedCached(executor, signer)
  if (!allowed) {
    return errorOf('NotWhitelisted', `${signer} is not a whitelisted guardian on ${parsed.chainSlug}`)
  }

  // 5. Post existence (also rejects purged posts — audit M-1)
  const exists = await postExists(executor, parsed.onchainId)
  if (!exists) {
    return errorOf('PostNotFound', `Post ${input.postId} not found on chain`)
  }

  // 6. Rate limit (creates only)
  const now = Date.now()
  const lastSeen = rateLimitMap.get(signer)
  if (lastSeen !== undefined && now - lastSeen < RATE_LIMIT_MS) {
    return errorOf('RateLimited', 'You are submitting comments too quickly')
  }

  // 7. Insert. Dedupe is enforced via the `comments_dedupe_idx`
  //    UNIQUE(signer_address, post_id, signed_at) index (audit M-2):
  //    a duplicate submission in flight loses the race and surfaces
  //    here as a 23505 unique_violation. We translate to
  //    DuplicateSubmission so the client renders correctly. The ±5min
  //    signed_at window upstream prevents replay; the unique index
  //    closes the read-then-insert race.
  const mh = typedDataHash(typedData)
  const signedAtDate = new Date(input.signedAt)
  let row: CommentDbRow
  try {
    const result = await metaPool.query<CommentDbRow>(
      `INSERT INTO comments (
         post_id, chain_slug, signer_address, body, signature, signed_at, message_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id::text, post_id, chain_slug, signer_address, body, signature,
                 signed_at, created_at, last_edited_at, message_hash`,
      [input.postId, parsed.chainSlug, signer, input.body, input.signature, signedAtDate.toISOString(), mh],
    )
    if (result.rows.length === 0) {
      return errorOf('InternalError', 'Insert returned no rows')
    }
    row = result.rows[0]!
  } catch (err) {
    if (isUniqueViolation(err)) {
      return errorOf('DuplicateSubmission', 'A matching comment was just submitted')
    }
    console.error('[comments] insert failed:', err)
    return errorOf('InternalError', 'Failed to persist comment')
  }

  // Mark rate-limit only on successful insert.
  rateLimitMap.set(signer, now)

  return successOf(rowToComment(row))
}

export const editComment = async (
  input: EditCommentInput,
  deps: ResolverDeps,
): Promise<SubmitCommentResult> => {
  const shapeErr = validateCommonShape(input)
  if (shapeErr) return shapeErr
  const bodyErr = validateBody(input.newBody)
  if (bodyErr) return bodyErr

  // L-3: validate commentId format upfront so we don't propagate a
  // malformed string to pg (where it'd surface as a generic invalid_text
  // error and get swallowed as InternalError).
  if (!isCommentIdString(input.commentId)) {
    return errorOf('CommentNotFound', `Comment ${input.commentId} not found`)
  }

  const parsed = parsePostId(input.postId, deps.chains)
  if (!parsed) {
    return errorOf('PostNotFound', `Unknown chain in postId: ${input.postId}`)
  }
  const chain = chainWithRegistry(deps.chains, parsed.chainSlug)
  if (!chain) {
    return errorOf('PostNotFound', `Chain ${parsed.chainSlug} has no registered comment surface`)
  }

  const typedData = buildEditTypedData({
    domain: buildDomain(chain),
    commentId: input.commentId,
    postId: input.postId,
    newBody: input.newBody,
    signedAt: input.signedAt,
  })
  const sig = await verifyTypedDataSignature({
    typedData,
    signature: input.signature,
    signer: input.signer,
  })
  if (!('ok' in sig)) return sig
  const signer = sig.recovered

  // Load existing comment first — saves a whitelist round trip when the
  // comment isn't owned by the caller anyway.
  const { rows: existingRows } = await metaPool.query<CommentDbRow>(
    `SELECT id::text, post_id, chain_slug, signer_address, body, signature,
            signed_at, created_at, last_edited_at, message_hash
       FROM comments
       WHERE id = $1`,
    [input.commentId],
  )
  const existing = existingRows[0]
  if (!existing) {
    return errorOf('CommentNotFound', `Comment ${input.commentId} not found`)
  }
  if (existing.post_id !== input.postId) {
    // Treat post mismatch as not-found rather than leaking the comment's
    // real post id.
    return errorOf('CommentNotFound', `Comment ${input.commentId} not found`)
  }
  if (!addressesEqual(existing.signer_address, signer)) {
    return errorOf('NotCommentOwner', 'You are not the author of this comment')
  }

  // Re-check whitelist. A signer who got removed from the whitelist
  // shouldn't be able to edit existing comments either.
  const executor = deps.getExecutor(parsed.chainSlug)
  if (!executor) {
    return errorOf('PostNotFound', `Chain ${parsed.chainSlug} not enabled`)
  }

  // M-1 (also blocks edits on purged posts).
  const stillVisible = await postExists(executor, parsed.onchainId)
  if (!stillVisible) {
    return errorOf('PostNotFound', `Post ${input.postId} not found on chain`)
  }

  const allowed = await isWhitelistedCached(executor, signer)
  if (!allowed) {
    return errorOf('NotWhitelisted', `${signer} is not a whitelisted guardian on ${parsed.chainSlug}`)
  }

  const mh = typedDataHash(typedData)
  const signedAtDate = new Date(input.signedAt)
  let row: CommentDbRow
  try {
    const result = await metaPool.query<CommentDbRow>(
      `UPDATE comments
          SET body = $1,
              signature = $2,
              signed_at = $3,
              message_hash = $4,
              last_edited_at = NOW()
        WHERE id = $5
        RETURNING id::text, post_id, chain_slug, signer_address, body, signature,
                  signed_at, created_at, last_edited_at, message_hash`,
      [input.newBody, input.signature, signedAtDate.toISOString(), mh, input.commentId],
    )
    if (result.rows.length === 0) {
      return errorOf('CommentNotFound', `Comment ${input.commentId} not found`)
    }
    row = result.rows[0]!
  } catch (err) {
    console.error('[comments] update failed:', err)
    return errorOf('InternalError', 'Failed to edit comment')
  }

  return successOf(rowToComment(row))
}

export const deleteComment = async (
  input: DeleteCommentInput,
  deps: ResolverDeps,
): Promise<DeleteCommentResult> => {
  const shapeErr = validateCommonShape(input)
  if (shapeErr) return shapeErr

  // L-3: validate commentId format upfront.
  if (!isCommentIdString(input.commentId)) {
    return errorOf('CommentNotFound', `Comment ${input.commentId} not found`)
  }

  const parsed = parsePostId(input.postId, deps.chains)
  if (!parsed) {
    return errorOf('PostNotFound', `Unknown chain in postId: ${input.postId}`)
  }
  const chain = chainWithRegistry(deps.chains, parsed.chainSlug)
  if (!chain) {
    return errorOf('PostNotFound', `Chain ${parsed.chainSlug} has no registered comment surface`)
  }

  const typedData = buildDeleteTypedData({
    domain: buildDomain(chain),
    commentId: input.commentId,
    postId: input.postId,
    signedAt: input.signedAt,
  })
  const sig = await verifyTypedDataSignature({
    typedData,
    signature: input.signature,
    signer: input.signer,
  })
  if (!('ok' in sig)) return sig
  const signer = sig.recovered

  const { rows: existingRows } = await metaPool.query<CommentDbRow>(
    `SELECT id::text, post_id, chain_slug, signer_address, body, signature,
            signed_at, created_at, last_edited_at, message_hash
       FROM comments
       WHERE id = $1`,
    [input.commentId],
  )
  const existing = existingRows[0]
  if (!existing) {
    return errorOf('CommentNotFound', `Comment ${input.commentId} not found`)
  }
  if (existing.post_id !== input.postId) {
    return errorOf('CommentNotFound', `Comment ${input.commentId} not found`)
  }
  if (!addressesEqual(existing.signer_address, signer)) {
    return errorOf('NotCommentOwner', 'You are not the author of this comment')
  }

  // M-1: block deletes on purged posts. A purged post means governance
  // already scrubbed it — there's nothing left to delete from a user-
  // visible perspective, and a successful delete would let an attacker
  // who guessed/knew their own commentId before the purge confirm
  // (out-of-band) which posts they had touched.
  const executor = deps.getExecutor(parsed.chainSlug)
  if (!executor) {
    return errorOf('PostNotFound', `Chain ${parsed.chainSlug} not enabled`)
  }
  const stillVisible = await postExists(executor, parsed.onchainId)
  if (!stillVisible) {
    return errorOf('PostNotFound', `Post ${input.postId} not found on chain`)
  }

  // No whitelist re-check for deletes: a deplatformed guardian still
  // needs the right to scrub their own off-chain content.
  try {
    const result = await metaPool.query(
      `DELETE FROM comments WHERE id = $1`,
      [input.commentId],
    )
    if (result.rowCount === 0) {
      return errorOf('CommentNotFound', `Comment ${input.commentId} not found`)
    }
  } catch (err) {
    console.error('[comments] delete failed:', err)
    return errorOf('InternalError', 'Failed to delete comment')
  }

  return { __typename: 'DeleteCommentSuccess', commentId: input.commentId }
}

// ---------------------------------------------------------------------------
// GraphQL bindings
// ---------------------------------------------------------------------------
//
// Schema additions for the stitched gateway. Mesh today is read-only;
// this is the first Mutation root we add. Wired via `additionalTypeDefs`
// + `additionalResolvers` exactly like the cross-chain `posts(...)`.
export const commentsTypeDefs = /* GraphQL */ `
  type Comment {
    id: ID!
    postId: String!
    chainSlug: String!
    signer: String!
    body: String!
    """ISO8601 timestamp set on insert. Immutable."""
    createdAt: String!
    """ISO8601 timestamp of last edit, or null if never edited."""
    lastEditedAt: String
    """ISO8601 timestamp the signer claimed in the canonical message."""
    signedAt: String!
    """Current EIP-712 signature. Surfaced so frontends can re-verify the comment client-side."""
    signature: String!
    """EIP-712 typed-data hash of the canonical message. Stored for audit; clients can recompute."""
    messageHash: String!
  }

  type SubmitCommentSuccess {
    comment: Comment!
  }

  """
  Discriminated error variant for every comment mutation. \`code\` is one of:
  NotWhitelisted, InvalidSignature, InvalidTimestamp, PostNotFound,
  RateLimited, DuplicateSubmission, BodyTooLong, BodyTooShort,
  NotCommentOwner, CommentNotFound, InternalError.
  """
  type SubmitCommentError {
    code: String!
    message: String!
  }

  union SubmitCommentResult = SubmitCommentSuccess | SubmitCommentError

  type DeleteCommentSuccess {
    commentId: ID!
  }

  union DeleteCommentResult = DeleteCommentSuccess | SubmitCommentError

  input SubmitCommentInput {
    postId: String!
    body: String!
    signer: String!
    signature: String!
    signedAt: String!
  }

  input EditCommentInput {
    commentId: ID!
    postId: String!
    newBody: String!
    signer: String!
    signature: String!
    signedAt: String!
  }

  input DeleteCommentInput {
    commentId: ID!
    postId: String!
    signer: String!
    signature: String!
    signedAt: String!
  }

  extend type Query {
    """Comments for a post, newest first. Composite postId, e.g. 'base-2'. Returns [] for purged posts."""
    comments(postId: String!, limit: Int = 50, offset: Int = 0): [Comment!]!
    """Total comment count for a post — drives the header count chip. Returns 0 for purged posts."""
    commentCount(postId: String!): Int!
  }

  type Mutation {
    """
    Create a new comment. Body must be 1-1000 chars. Signer must be a
    currently-whitelisted guardian on the post's chain. signedAt must be
    within ±5 minutes of server clock. Signature is EIP-712 typed data
    bound to the registry proxy on the post's chain.
    """
    submitComment(input: SubmitCommentInput!): SubmitCommentResult!

    """
    Edit an existing comment. Only the original signer can edit. Re-signs
    the canonical edit typed-data and overwrites body + signature + signedAt.
    """
    editComment(input: EditCommentInput!): SubmitCommentResult!

    """Delete a comment. Only the original signer can delete. Hard delete."""
    deleteComment(input: DeleteCommentInput!): DeleteCommentResult!
  }
`

export const buildCommentsResolvers = (deps: ResolverDeps) => ({
  Query: {
    comments: (
      _root: unknown,
      args: { postId: string; limit?: number; offset?: number },
    ) => listComments(args.postId, args.limit ?? 50, args.offset ?? 0, deps),
    commentCount: (
      _root: unknown,
      args: { postId: string },
    ) => commentCount(args.postId, deps),
  },
  Mutation: {
    submitComment: (
      _root: unknown,
      args: { input: SubmitCommentInput },
    ) => createComment(args.input, deps),
    editComment: (
      _root: unknown,
      args: { input: EditCommentInput },
    ) => editComment(args.input, deps),
    deleteComment: (
      _root: unknown,
      args: { input: DeleteCommentInput },
    ) => deleteComment(args.input, deps),
  },
  // Union resolution. Successes carry __typename already; errors do too.
  SubmitCommentResult: {
    __resolveType: (obj: SubmitCommentResult) => obj.__typename,
  },
  DeleteCommentResult: {
    __resolveType: (obj: DeleteCommentResult) => obj.__typename,
  },
})
