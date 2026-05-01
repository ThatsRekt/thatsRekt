// =============================================================================
// Comments — GraphQL helpers + canonical message builders.
// =============================================================================
// Backed by the Mesh comments mutation surface (frozen contract). Each
// mutation returns a discriminated union; helpers unwrap and either
// return the success value or throw a typed `CommentMutationError`. The
// caller (mutation hooks) inspects `error.code` to drive UI.

import { gqlClient } from './client'

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

// ---- canonical message builders --------------------------------------------
// The wallet signs the EIP-191 prefix automatically (wagmi's
// `useSignMessage` handles that). What we build here is the unprefixed
// message body — must match the backend's verification byte-for-byte.

/** Build the canonical create-comment message string. */
export const buildCreateMessage = (
  postId: string,
  body: string,
  signedAt: string,
): string =>
  [
    'thatsRekt comment v1',
    'op: create',
    `post: ${postId}`,
    `signed_at: ${signedAt}`,
    `body: ${body}`,
  ].join('\n')

/** Build the canonical edit-comment message string. */
export const buildEditMessage = (
  commentId: string,
  postId: string,
  newBody: string,
  signedAt: string,
): string =>
  [
    'thatsRekt comment v1',
    'op: edit',
    `comment_id: ${commentId}`,
    `post: ${postId}`,
    `signed_at: ${signedAt}`,
    `body: ${newBody}`,
  ].join('\n')

/** Build the canonical delete-comment message string. */
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
