// =============================================================================
// Comments — GraphQL helpers + canonical EIP-712 typed-data builders.
// =============================================================================
// Backed by the Mesh comments mutation surface (frozen contract). Each
// mutation returns a discriminated union; helpers unwrap and either
// return the success value or throw a typed `CommentMutationError`. The
// caller (mutation hooks) inspects `error.code` to drive UI.
//
// The signing contract uses EIP-712 typed data (not personal_sign). This
// means wallets render parsed field/value rows (Domain: thatsRekt v1 /
// chainId N / contract 0x… / Type: CreateComment / postId / body / signedAt)
// instead of opaque text. The domain binds each signature to a specific
// chain + registry contract — replaying a signature across chains or
// against a different contract fails verification.

import { gqlClient } from './client'
import { REGISTRY_PROXIES } from './contracts'
import { getChainBySlug } from './chains'

// ---- types (mirror the GraphQL `Comment` type exactly) ----------------------

/** Single comment row, shape matches `Comment` GraphQL type 1:1. */
export interface Comment {
  id: string
  /** Composite "{slug}-{onchainId}" — same as PostDetail consumers. */
  postId: string
  chainSlug: string
  /** Lowercase 0x address. */
  signer: string
  body: string
  createdAt: string
  /** ISO timestamp — null if the comment has never been edited. */
  lastEditedAt: string | null
  signedAt: string
  signature: string
  messageHash: string
}

/** Possible error `code` values returned by `SubmitCommentError`. */
export type CommentErrorCode =
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
  // Client-side synthetic codes — produced by hooks, never by the server.
  | 'UserRejected'
  | 'NetworkError'

/**
 * Thrown by mutation helpers when the server returns the error variant of
 * `SubmitCommentResult` / `DeleteCommentResult`. Keeps the typed code
 * available to callers without making them parse the union themselves.
 */
export class CommentMutationError extends Error {
  readonly code: CommentErrorCode
  constructor(code: CommentErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'CommentMutationError'
  }
}

// ---- input shapes -----------------------------------------------------------

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

// ---- canonical EIP-712 typed-data builders ---------------------------------
// The frontend builds typed data (domain + types + message) and hands it to
// wagmi's `useSignTypedData`. The backend verifies the same typed-data
// payload via viem's `verifyTypedData` — the two halves must match
// byte-for-byte (any drift in the type ordering, field names, or domain
// surfaces as `InvalidSignature`).
//
// Domain binds each signature to (chainId, verifyingContract). The chainId
// is derived from the post's chain slug; the verifyingContract is the
// registry proxy on that chain. Replaying a Base signature against
// Base Sepolia, or against a different contract, fails verification.

/** EIP-712 domain. Per-chain — chainId + verifyingContract change. */
export interface CommentDomain {
  name: string
  version: string
  chainId: number
  verifyingContract: `0x${string}`
}

/**
 * EIP-712 type definitions for the three comment operations. Frozen —
 * any change here is a contract break that requires both halves to bump
 * the domain version in lockstep. `commentId` is `uint256` on the wire
 * (passed as a `bigint` to viem's signTypedData call); the GraphQL
 * `Comment.id` is a string, so callers convert via `BigInt(comment.id)`
 * at the signing site.
 */
export const COMMENT_TYPES = {
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
} as const

// ---- post-id → chain-slug helper -------------------------------------------
//
// Composite postIds look like `{slug}-{onchainId}`, e.g. `base-42` or
// `base-sepolia-7`. We have to match the *longest* slug first so
// `base-sepolia-7` doesn't get parsed as `base` + `sepolia-7`.

const KNOWN_SLUGS = [
  'anvil-eth',
  'anvil-base',
  'sepolia',
  'base-sepolia',
  'base',
  'optimism',
  'ethereum',
  'arbitrum',
  'bsc',
  'blast',
] as const

const chainSlugFromPostId = (postId: string): string => {
  // Sort longest-first to avoid `base-sepolia` matching as `base`.
  const sorted = [...KNOWN_SLUGS].sort((a, b) => b.length - a.length)
  for (const slug of sorted) {
    if (postId.startsWith(`${slug}-`)) return slug
  }
  throw new Error(`cannot derive chain slug from postId: ${postId}`)
}

const commentDomainFor = (postId: string): CommentDomain => {
  const slug = chainSlugFromPostId(postId)
  const chain = getChainBySlug(slug)
  if (!chain) throw new Error(`unknown chain slug: ${slug}`)
  const verifyingContract = (REGISTRY_PROXIES as Record<number, `0x${string}`>)[chain.chainId]
  if (!verifyingContract) {
    throw new Error(`no registry contract deployed on chainId ${chain.chainId}`)
  }
  return {
    name: 'thatsRekt',
    version: '1',
    chainId: chain.chainId,
    verifyingContract,
  }
}

/** Public typed-data shape returned by every builder. */
export interface CreateCommentTypedData {
  domain: CommentDomain
  types: typeof COMMENT_TYPES
  primaryType: 'CreateComment'
  message: { postId: string; body: string; signedAt: string }
}

export interface EditCommentTypedData {
  domain: CommentDomain
  types: typeof COMMENT_TYPES
  primaryType: 'EditComment'
  message: { commentId: bigint; postId: string; newBody: string; signedAt: string }
}

export interface DeleteCommentTypedData {
  domain: CommentDomain
  types: typeof COMMENT_TYPES
  primaryType: 'DeleteComment'
  message: { commentId: bigint; postId: string; signedAt: string }
}

/** Build EIP-712 typed data for a create-comment signature. */
export const buildCreateTypedData = (
  postId: string,
  body: string,
  signedAt: string,
): CreateCommentTypedData => ({
  domain: commentDomainFor(postId),
  types: COMMENT_TYPES,
  primaryType: 'CreateComment',
  message: { postId, body, signedAt },
})

/** Build EIP-712 typed data for an edit-comment signature. */
export const buildEditTypedData = (
  commentId: string,
  postId: string,
  newBody: string,
  signedAt: string,
): EditCommentTypedData => ({
  domain: commentDomainFor(postId),
  types: COMMENT_TYPES,
  primaryType: 'EditComment',
  message: {
    // GraphQL `Comment.id` is a string; viem accepts a bigint for uint256.
    commentId: BigInt(commentId),
    postId,
    newBody,
    signedAt,
  },
})

/** Build EIP-712 typed data for a delete-comment signature. */
export const buildDeleteTypedData = (
  commentId: string,
  postId: string,
  signedAt: string,
): DeleteCommentTypedData => ({
  domain: commentDomainFor(postId),
  types: COMMENT_TYPES,
  primaryType: 'DeleteComment',
  message: {
    commentId: BigInt(commentId),
    postId,
    signedAt,
  },
})

// ---- queries ----------------------------------------------------------------

const COMMENT_FIELDS = /* GraphQL */ `
  id
  postId
  chainSlug
  signer
  body
  createdAt
  lastEditedAt
  signedAt
  signature
  messageHash
`

const COMMENTS_QUERY = /* GraphQL */ `
  query Comments($postId: String!, $limit: Int = 50, $offset: Int = 0) {
    comments(postId: $postId, limit: $limit, offset: $offset) {
      ${COMMENT_FIELDS}
    }
  }
`

const COMMENT_COUNT_QUERY = /* GraphQL */ `
  query CommentCount($postId: String!) {
    commentCount(postId: $postId)
  }
`

const SUBMIT_COMMENT_MUTATION = /* GraphQL */ `
  mutation SubmitComment($input: SubmitCommentInput!) {
    submitComment(input: $input) {
      __typename
      ... on SubmitCommentSuccess {
        comment {
          ${COMMENT_FIELDS}
        }
      }
      ... on SubmitCommentError {
        code
        message
      }
    }
  }
`

const EDIT_COMMENT_MUTATION = /* GraphQL */ `
  mutation EditComment($input: EditCommentInput!) {
    editComment(input: $input) {
      __typename
      ... on SubmitCommentSuccess {
        comment {
          ${COMMENT_FIELDS}
        }
      }
      ... on SubmitCommentError {
        code
        message
      }
    }
  }
`

const DELETE_COMMENT_MUTATION = /* GraphQL */ `
  mutation DeleteComment($input: DeleteCommentInput!) {
    deleteComment(input: $input) {
      __typename
      ... on DeleteCommentSuccess {
        commentId
      }
      ... on SubmitCommentError {
        code
        message
      }
    }
  }
`

// ---- raw GraphQL response shapes -------------------------------------------
// Distinct from the public types so the discriminated union stays
// faithful to the wire format.

interface SubmitCommentSuccessRaw {
  __typename: 'SubmitCommentSuccess'
  comment: Comment
}

interface SubmitCommentErrorRaw {
  __typename: 'SubmitCommentError'
  code: CommentErrorCode
  message: string
}

type SubmitCommentResultRaw = SubmitCommentSuccessRaw | SubmitCommentErrorRaw

interface DeleteCommentSuccessRaw {
  __typename: 'DeleteCommentSuccess'
  commentId: string
}

type DeleteCommentResultRaw = DeleteCommentSuccessRaw | SubmitCommentErrorRaw

// ---- query helpers ----------------------------------------------------------

/**
 * Fetch the comment list for a post. Returns the raw server order — the
 * Mesh resolver is responsible for the canonical ordering (most-recent
 * first per spec). Empty result = empty array, never null.
 */
export async function fetchComments(
  postId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<Comment[]> {
  if (!postId) throw new Error('fetchComments: postId is required')
  const limit = opts.limit ?? 50
  const offset = opts.offset ?? 0
  const data = await gqlClient.request<{ comments: Comment[] }>(COMMENTS_QUERY, {
    postId,
    limit,
    offset,
  })
  // Defensive: server should never return null, but guard so the UI's
  // `?? []` fallback keeps working even if the wire shape drifts.
  return data.comments ?? []
}

/** Lightweight count-only query for the metadata-row chip. */
export async function fetchCommentCount(postId: string): Promise<number> {
  if (!postId) throw new Error('fetchCommentCount: postId is required')
  const data = await gqlClient.request<{ commentCount: number }>(COMMENT_COUNT_QUERY, {
    postId,
  })
  // Same defensive guard — fall back to 0 for any non-finite return.
  const n = data.commentCount
  return Number.isFinite(n) && n >= 0 ? n : 0
}

// ---- mutation helpers -------------------------------------------------------

/**
 * Submit a new comment. Returns the created `Comment` on success.
 * Throws `CommentMutationError` (with a typed `code`) on the server's
 * error variant. Network / transport failures bubble up as plain
 * `Error` — callers wrap those into `NetworkError` if they want a
 * uniform UI.
 */
export async function submitComment(input: SubmitCommentInput): Promise<Comment> {
  const data = await gqlClient.request<{ submitComment: SubmitCommentResultRaw }>(
    SUBMIT_COMMENT_MUTATION,
    { input },
  )
  return unwrapSubmitResult(data.submitComment)
}

/** Edit an existing comment. Same return / error semantics as `submitComment`. */
export async function editComment(input: EditCommentInput): Promise<Comment> {
  const data = await gqlClient.request<{ editComment: SubmitCommentResultRaw }>(
    EDIT_COMMENT_MUTATION,
    { input },
  )
  return unwrapSubmitResult(data.editComment)
}

/**
 * Delete a comment. Returns the deleted `commentId` on success.
 * Throws `CommentMutationError` on the error variant.
 */
export async function deleteComment(input: DeleteCommentInput): Promise<string> {
  const data = await gqlClient.request<{ deleteComment: DeleteCommentResultRaw }>(
    DELETE_COMMENT_MUTATION,
    { input },
  )
  return unwrapDeleteResult(data.deleteComment)
}

// ---- result unwrapping ------------------------------------------------------

const unwrapSubmitResult = (result: SubmitCommentResultRaw): Comment => {
  if (result.__typename === 'SubmitCommentSuccess') {
    return result.comment
  }
  throw new CommentMutationError(result.code, result.message)
}

const unwrapDeleteResult = (result: DeleteCommentResultRaw): string => {
  if (result.__typename === 'DeleteCommentSuccess') {
    return result.commentId
  }
  throw new CommentMutationError(result.code, result.message)
}
