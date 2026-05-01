/**
 * Off-chain guardian comments — full validation pipeline + resolvers.
 *
 * Comments are signed via EIP-191 `personal_sign` by the guardian's
 * wallet. The server reconstructs the canonical message string, recovers
 * the address with viem, and asserts it matches the claimed signer. Only
 * whitelisted (per the on-chain registry on the comment's chain)
 * guardians can post; only the original signer can edit or delete.
 *
 * No version history. Edits overwrite. Deletes are hard. Per the
 * operator's call: "no need to overengineer this."
 *
 * Storage: shared `thatsrekt_meta` Postgres database, single `comments`
 * table. See `db.ts` for the schema.
 */
import { keccak256, recoverMessageAddress, toHex } from 'viem'
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
const DEDUPE_WINDOW_MS = 30_000       // duplicate creates inside 30s collapse
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const SIGNATURE_RE = /^0x[a-fA-F0-9]{130}$/

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
// Canonical message construction
// ---------------------------------------------------------------------------
//
// Three op variants — create / edit / delete. The exact string is
// reconstructed server-side from input fields and recovered with
// `recoverMessageAddress` (EIP-191 personal_sign). Any drift between the
// client and server formatters is rejected as `InvalidSignature`.

export const buildCreateMessage = (postId: string, signedAt: string, body: string): string =>
  [
    'thatsRekt comment v1',
    'op: create',
    `post: ${postId}`,
    `signed_at: ${signedAt}`,
    `body: ${body}`,
  ].join('\n')

export const buildEditMessage = (
  commentId: string,
  postId: string,
  signedAt: string,
  body: string,
): string =>
  [
    'thatsRekt comment v1',
    'op: edit',
    `comment_id: ${commentId}`,
    `post: ${postId}`,
    `signed_at: ${signedAt}`,
    `body: ${body}`,
  ].join('\n')

export const buildDeleteMessage = (
  commentId: string,
  postId: string,
  signedAt: string,
): string =>
  [
    'thatsRekt comment v1',
    'op: delete',
    `comment_id: ${commentId}`,
    `post: ${postId}`,
    `signed_at: ${signedAt}`,
  ].join('\n')

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

/** Normalize an address to lowercase 0x-prefixed hex. */
const normalizeAddress = (s: string): string => s.toLowerCase()

/** Equality on EVM addresses, case-insensitive. */
const addressesEqual = (a: string, b: string): boolean =>
  normalizeAddress(a) === normalizeAddress(b)

/** Hash the canonical message — stored alongside the row for audit. */
const messageHashOf = (msg: string): string => keccak256(toHex(msg))

/** Body hash — used for the create-side dedupe predicate. */
const bodyHashOf = (body: string): string => keccak256(toHex(body))

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
 * Recover the signing address from a canonical message + signature, and
 * assert it matches the claimed signer. Returns the recovered address on
 * success or a result-shaped error on mismatch / recovery failure.
 */
export const verifySignature = async (params: {
  message: string
  signature: string
  signer: string
}): Promise<{ ok: true; recovered: string } | ErrorVariant> => {
  let recovered: string
  try {
    recovered = await recoverMessageAddress({
      message: params.message,
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

/** Returns true iff the on-chain post exists on the chain's indexer. */
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
  return isPlainObject(p) && typeof p.id === 'string'
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
 * Look for a row matching `(signer, post_id, body_hash, signed_at within
 * 30s)`. We don't have a stored body_hash column (would bloat the row);
 * recompute it on the candidate set instead. The candidate set is
 * scoped to the same signer + post + 30s window, which is tiny.
 */
const findDuplicateCreate = async (params: {
  signer: string
  postId: string
  bodyHash: string
  signedAt: Date
}): Promise<boolean> => {
  const lo = new Date(params.signedAt.getTime() - DEDUPE_WINDOW_MS)
  const hi = new Date(params.signedAt.getTime() + DEDUPE_WINDOW_MS)
  const { rows } = await metaPool.query<{ body: string }>(
    `SELECT body FROM comments
       WHERE signer_address = $1
         AND post_id = $2
         AND signed_at BETWEEN $3 AND $4`,
    [params.signer, params.postId, lo.toISOString(), hi.toISOString()],
  )
  for (const r of rows) {
    if (bodyHashOf(r.body) === params.bodyHash) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Public read resolvers
// ---------------------------------------------------------------------------

export const listComments = async (
  postId: string,
  limit: number,
  offset: number,
): Promise<CommentRow[]> => {
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

export const commentCount = async (postId: string): Promise<number> => {
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

  // 2. Resolve chain slug from composite postId
  const parsed = parsePostId(input.postId, deps.chains)
  if (!parsed) {
    return errorOf('PostNotFound', `Unknown chain in postId: ${input.postId}`)
  }
  const executor = deps.getExecutor(parsed.chainSlug)
  if (!executor) {
    return errorOf('PostNotFound', `Chain ${parsed.chainSlug} not enabled`)
  }

  // 3. Signature recovery on the canonical message
  const message = buildCreateMessage(input.postId, input.signedAt, input.body)
  const sig = await verifySignature({
    message,
    signature: input.signature,
    signer: input.signer,
  })
  if (!('ok' in sig)) return sig
  const signer = sig.recovered // lowercased

  // 4. Whitelist gate
  const allowed = await isWhitelisted(executor, signer)
  if (!allowed) {
    return errorOf('NotWhitelisted', `${signer} is not a whitelisted guardian on ${parsed.chainSlug}`)
  }

  // 5. Post existence
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

  // 7. Dedupe within 30s
  const signedAtDate = new Date(input.signedAt)
  const bh = bodyHashOf(input.body)
  if (
    await findDuplicateCreate({
      signer,
      postId: input.postId,
      bodyHash: bh,
      signedAt: signedAtDate,
    })
  ) {
    return errorOf('DuplicateSubmission', 'A matching comment was just submitted')
  }

  // 8. Insert
  const mh = messageHashOf(message)
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

  const parsed = parsePostId(input.postId, deps.chains)
  if (!parsed) {
    return errorOf('PostNotFound', `Unknown chain in postId: ${input.postId}`)
  }

  const message = buildEditMessage(input.commentId, input.postId, input.signedAt, input.newBody)
  const sig = await verifySignature({
    message,
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
  const allowed = await isWhitelisted(executor, signer)
  if (!allowed) {
    return errorOf('NotWhitelisted', `${signer} is not a whitelisted guardian on ${parsed.chainSlug}`)
  }

  const mh = messageHashOf(message)
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

  const parsed = parsePostId(input.postId, deps.chains)
  if (!parsed) {
    return errorOf('PostNotFound', `Unknown chain in postId: ${input.postId}`)
  }

  const message = buildDeleteMessage(input.commentId, input.postId, input.signedAt)
  const sig = await verifySignature({
    message,
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
    """Current EIP-191 signature. Surfaced so frontends can re-verify the comment client-side."""
    signature: String!
    """keccak256 of the canonical message string. Stored for audit; clients can recompute."""
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
    """Comments for a post, newest first. Composite postId, e.g. 'base-2'."""
    comments(postId: String!, limit: Int = 50, offset: Int = 0): [Comment!]!
    """Total comment count for a post — drives the header count chip."""
    commentCount(postId: String!): Int!
  }

  type Mutation {
    """
    Create a new comment. Body must be 1-1000 chars. Signer must be a
    currently-whitelisted guardian on the post's chain. signedAt must be
    within ±5 minutes of server clock.
    """
    submitComment(input: SubmitCommentInput!): SubmitCommentResult!

    """
    Edit an existing comment. Only the original signer can edit. Re-signs
    the canonical edit message and overwrites body + signature + signedAt.
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
    ) => listComments(args.postId, args.limit ?? 50, args.offset ?? 0),
    commentCount: (
      _root: unknown,
      args: { postId: string },
    ) => commentCount(args.postId),
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
