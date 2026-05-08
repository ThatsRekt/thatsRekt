/**
 * Unit tests for the comments validation pipeline.
 *
 * Strategy: mock the `metaPool` and per-chain executors via bun:test
 * `mock.module`, drive the resolvers with synthesized signed payloads,
 * and verify the discriminated-union outputs.
 *
 * Pure helpers (parsePostId, buildCreateTypedData, etc.) are exercised
 * directly without mocks.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { privateKeyToAccount } from 'viem/accounts'
import { hashTypedData } from 'viem'

// --- Test-time mocks ------------------------------------------------------
//
// Mock the meta pool BEFORE importing the comments module so the resolver
// imports see the mocked surface. We track every query call on a list so
// individual tests can stub responses by query-pattern matching.

interface PoolCall {
  text: string
  values: unknown[]
}

let poolCalls: PoolCall[] = []
let poolHandler: (text: string, values: unknown[]) => { rows: unknown[]; rowCount?: number }

const resetPoolHandler = () => {
  poolCalls = []
  poolHandler = () => ({ rows: [], rowCount: 0 })
}
resetPoolHandler()

await mock.module('../src/db.ts', () => ({
  metaPool: {
    query: async (text: string, values: unknown[]) => {
      poolCalls.push({ text, values })
      return poolHandler(text, values)
    },
  },
  ensureCommentsTable: async () => {},
}))

// Importing AFTER mock.module so the comments module sees the mocked db.
const {
  buildCreateTypedData,
  buildEditTypedData,
  buildDeleteTypedData,
  buildDomain,
  parsePostId,
  verifyTypedDataSignature,
  createComment,
  editComment,
  deleteComment,
  resetRateLimit,
  resetFailedWhitelist,
  stopRateLimitGc,
  COMMENT_TYPES,
} = await import('../src/comments.ts')

import type { ChainEntry } from '../src/chains.ts'
import type { Executor } from '@graphql-tools/utils'
import type { ExecutionResult } from 'graphql'

// --- Fixtures -------------------------------------------------------------

const BASE_REGISTRY = '0xBfaEEE9662b4c037De24e5Caa65815350d57b89A' as const
const BASE_SEPOLIA_REGISTRY = '0x5278dD25e8551Cc98f2dC89791f5C89a9C83F695' as const

const TEST_CHAINS: readonly ChainEntry[] = Object.freeze([
  {
    chainId: 8453,
    slug: 'base',
    name: 'Base',
    prefix: 'Base_',
    endpoint: 'http://test/base',
    registryAddress: BASE_REGISTRY,
  },
  {
    chainId: 84532,
    slug: 'base-sepolia',
    name: 'Base Sepolia',
    prefix: 'BaseSepolia_',
    endpoint: 'http://test/base-sepolia',
    registryAddress: BASE_SEPOLIA_REGISTRY,
  },
])

const baseChainEntry = TEST_CHAINS[0] as ChainEntry & { registryAddress: `0x${string}` }
const BASE_DOMAIN = buildDomain(baseChainEntry)

// Build a per-test signed-comment payload.
const TEST_PRIVKEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVKEY)
const TEST_ADDRESS = TEST_ACCOUNT.address.toLowerCase()

const signCreateTd = async (input: {
  postId: string
  body: string
  signedAt: string
}): Promise<`0x${string}`> => {
  const td = buildCreateTypedData({ domain: BASE_DOMAIN, ...input })
  return TEST_ACCOUNT.signTypedData({
    domain: td.domain,
    types: COMMENT_TYPES,
    primaryType: 'CreateComment',
    message: td.message,
  })
}

const signEditTd = async (input: {
  commentId: string
  postId: string
  newBody: string
  signedAt: string
}): Promise<`0x${string}`> => {
  const td = buildEditTypedData({ domain: BASE_DOMAIN, ...input })
  return TEST_ACCOUNT.signTypedData({
    domain: td.domain,
    types: COMMENT_TYPES,
    primaryType: 'EditComment',
    message: td.message,
  })
}

const signDeleteTd = async (input: {
  commentId: string
  postId: string
  signedAt: string
}): Promise<`0x${string}`> => {
  const td = buildDeleteTypedData({ domain: BASE_DOMAIN, ...input })
  return TEST_ACCOUNT.signTypedData({
    domain: td.domain,
    types: COMMENT_TYPES,
    primaryType: 'DeleteComment',
    message: td.message,
  })
}

// --- Executor helpers -----------------------------------------------------
//
// Each test installs a mock executor that returns a deterministic
// response based on the query text. Tests that don't care about a
// specific path get a permissive default that returns truthy
// whitelister + post for any call.

type ExecutorResponse = (vars: Record<string, unknown>) => ExecutionResult

const buildExecutor = (
  whitelistResponse: ExecutorResponse,
  postResponse: ExecutorResponse,
): Executor =>
  (async ({ document, variables }) => {
    const v = (variables ?? {}) as Record<string, unknown>
    const printed = JSON.stringify(document)
    if (printed.includes('whitelisterById')) return whitelistResponse(v)
    if (printed.includes('postById')) return postResponse(v)
    return { data: null }
  }) as Executor

const okWhitelist: ExecutorResponse = (v) => ({
  data: {
    whitelisterById: { id: String(v['id']), isCurrentlyWhitelisted: true },
  },
})
const noWhitelist: ExecutorResponse = () => ({
  data: { whitelisterById: null },
})
const okPost: ExecutorResponse = (v) => ({
  data: { postById: { id: String(v['id']), purged: false } },
})
const purgedPost: ExecutorResponse = (v) => ({
  data: { postById: { id: String(v['id']), purged: true } },
})
const noPost: ExecutorResponse = () => ({
  data: { postById: null },
})

const buildDeps = (executor: Executor) => ({
  chains: TEST_CHAINS,
  getExecutor: (slug: string) => (TEST_CHAINS.some((c) => c.slug === slug) ? executor : null),
})

afterEach(() => {
  resetPoolHandler()
  resetRateLimit()
  resetFailedWhitelist()
})

beforeAll(() => {
  // Keep tests deterministic — disable the rate-limit GC.
  stopRateLimitGc()
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parsePostId', () => {
  test('matches the longest chain slug first', () => {
    const out = parsePostId('base-sepolia-42', TEST_CHAINS)
    expect(out).toEqual({ chainSlug: 'base-sepolia', onchainId: '42' })
  })

  test('matches a short slug too', () => {
    const out = parsePostId('base-7', TEST_CHAINS)
    expect(out).toEqual({ chainSlug: 'base', onchainId: '7' })
  })

  test('rejects unknown chains', () => {
    expect(parsePostId('mars-1', TEST_CHAINS)).toBeNull()
  })

  test('rejects non-numeric onchain id', () => {
    expect(parsePostId('base-abc', TEST_CHAINS)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// EIP-712 fingerprint tests (audit H-2)
// ---------------------------------------------------------------------------
//
// Cross-repo contract: the frontend agent has the same assertions on
// the same hash values. Any drift in field order, domain, or primary
// type would break sigs in flight — these tests catch it before deploy.

describe('canonical typed-data fingerprint', () => {
  test('CreateComment fingerprint is stable', () => {
    const td = buildCreateTypedData({
      domain: BASE_DOMAIN,
      postId: 'base-1',
      body: 'gm',
      signedAt: '2026-05-01T00:00:00.000Z',
    })
    expect(td.domain).toEqual({
      name: 'thatsRekt',
      version: '1',
      chainId: 8453,
      verifyingContract: BASE_REGISTRY,
    })
    expect(td.primaryType).toBe('CreateComment')
    expect(td.message).toEqual({
      postId: 'base-1',
      body: 'gm',
      signedAt: '2026-05-01T00:00:00.000Z',
    })
    expect(
      hashTypedData({
        domain: td.domain,
        types: COMMENT_TYPES,
        primaryType: 'CreateComment',
        message: td.message,
      }),
    ).toBe('0x4cc2ac84dc2533f16551dd25cd366739df9a5c5fe21248e0b3143e1bf4601a5e')
  })

  test('EditComment fingerprint is stable', () => {
    const td = buildEditTypedData({
      domain: BASE_DOMAIN,
      commentId: '42',
      postId: 'base-1',
      newBody: 'gm edited',
      signedAt: '2026-05-01T00:00:00.000Z',
    })
    expect(td.primaryType).toBe('EditComment')
    expect(td.message).toEqual({
      commentId: 42n,
      postId: 'base-1',
      newBody: 'gm edited',
      signedAt: '2026-05-01T00:00:00.000Z',
    })
    expect(
      hashTypedData({
        domain: td.domain,
        types: COMMENT_TYPES,
        primaryType: 'EditComment',
        message: td.message,
      }),
    ).toBe('0xa4252bd7819558df94b7226cc0b345b774cd30cc003ce0293de9d8f869fff1fa')
  })

  test('DeleteComment fingerprint is stable', () => {
    const td = buildDeleteTypedData({
      domain: BASE_DOMAIN,
      commentId: '42',
      postId: 'base-1',
      signedAt: '2026-05-01T00:00:00.000Z',
    })
    expect(td.primaryType).toBe('DeleteComment')
    expect(td.message).toEqual({
      commentId: 42n,
      postId: 'base-1',
      signedAt: '2026-05-01T00:00:00.000Z',
    })
    expect(
      hashTypedData({
        domain: td.domain,
        types: COMMENT_TYPES,
        primaryType: 'DeleteComment',
        message: td.message,
      }),
    ).toBe('0xe056613511a58b7f627565644c2a99c13776f1e238ff74b2d57cd612bbeaa3d1')
  })
})

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe('verifyTypedDataSignature', () => {
  test('accepts a valid signature from the claimed signer', async () => {
    const td = buildCreateTypedData({
      domain: BASE_DOMAIN,
      postId: 'base-1',
      body: 'gm',
      signedAt: '2026-05-01T00:00:00.000Z',
    })
    const sig = await TEST_ACCOUNT.signTypedData({
      domain: td.domain,
      types: COMMENT_TYPES,
      primaryType: 'CreateComment',
      message: td.message,
    })
    const out = await verifyTypedDataSignature({
      typedData: td,
      signature: sig,
      signer: TEST_ADDRESS,
    })
    expect('ok' in out && out.ok).toBe(true)
    if ('ok' in out) {
      expect(out.recovered).toBe(TEST_ADDRESS)
    }
  })

  test('rejects when claimed signer is a different address', async () => {
    const td = buildCreateTypedData({
      domain: BASE_DOMAIN,
      postId: 'base-1',
      body: 'gm',
      signedAt: '2026-05-01T00:00:00.000Z',
    })
    const sig = await TEST_ACCOUNT.signTypedData({
      domain: td.domain,
      types: COMMENT_TYPES,
      primaryType: 'CreateComment',
      message: td.message,
    })
    const wrong = '0x0000000000000000000000000000000000000001'
    const out = await verifyTypedDataSignature({
      typedData: td,
      signature: sig,
      signer: wrong,
    })
    expect('ok' in out).toBe(false)
    expect(out).toMatchObject({
      __typename: 'SubmitCommentError',
      code: 'InvalidSignature',
    })
  })

  test('rejects malformed signatures', async () => {
    const td = buildCreateTypedData({
      domain: BASE_DOMAIN,
      postId: 'base-1',
      body: 'gm',
      signedAt: '2026-05-01T00:00:00.000Z',
    })
    const out = await verifyTypedDataSignature({
      typedData: td,
      signature: '0xdeadbeef',
      signer: TEST_ADDRESS,
    })
    expect(out).toMatchObject({ code: 'InvalidSignature' })
  })
})

// ---------------------------------------------------------------------------
// Helper to build a stub poolHandler that returns a fully-formed comment
// row from INSERT and an empty list for everything else.
// ---------------------------------------------------------------------------

const buildInsertPoolHandler = (params: {
  signer: string
  postId: string
  body: string
  signature: string
  signedAt: string
  messageHash: string
}) => (text: string) => {
  if (text.startsWith('INSERT INTO comments')) {
    return {
      rows: [
        {
          id: '1',
          post_id: params.postId,
          chain_slug: 'base',
          signer_address: params.signer,
          body: params.body,
          signature: params.signature,
          signed_at: new Date(params.signedAt),
          created_at: new Date(params.signedAt),
          last_edited_at: null,
          message_hash: params.messageHash,
        },
      ],
    }
  }
  return { rows: [] }
}

// ---------------------------------------------------------------------------
// createComment full pipeline
// ---------------------------------------------------------------------------

describe('createComment', () => {
  test('rejects when signedAt is outside the ±5min window', async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const body = 'gm'
    const sig = await signCreateTd({ postId: 'base-1', body, signedAt: stale })
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    const out = await createComment(
      { postId: 'base-1', body, signer: TEST_ADDRESS, signature: sig, signedAt: stale },
      deps,
    )
    expect(out).toMatchObject({ code: 'InvalidTimestamp' })
  })

  test('rejects when body is empty', async () => {
    const now = new Date().toISOString()
    const body = ''
    // Sign anyway — body validation runs before signature recovery, but
    // we still need a structurally-valid signature to pass shape checks.
    const sig = await signCreateTd({ postId: 'base-1', body, signedAt: now })
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    const out = await createComment(
      { postId: 'base-1', body, signer: TEST_ADDRESS, signature: sig, signedAt: now },
      deps,
    )
    expect(out).toMatchObject({ code: 'BodyTooShort' })
  })

  test('rejects when body exceeds 1000 chars', async () => {
    const now = new Date().toISOString()
    const body = 'a'.repeat(1001)
    const sig = await signCreateTd({ postId: 'base-1', body, signedAt: now })
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    const out = await createComment(
      { postId: 'base-1', body, signer: TEST_ADDRESS, signature: sig, signedAt: now },
      deps,
    )
    expect(out).toMatchObject({ code: 'BodyTooLong' })
  })

  test('rejects when signer is not whitelisted', async () => {
    const now = new Date().toISOString()
    const body = 'gm'
    const sig = await signCreateTd({ postId: 'base-1', body, signedAt: now })
    const deps = buildDeps(buildExecutor(noWhitelist, okPost))

    const out = await createComment(
      { postId: 'base-1', body, signer: TEST_ADDRESS, signature: sig, signedAt: now },
      deps,
    )
    expect(out).toMatchObject({ code: 'NotWhitelisted' })
  })

  test('rejects when post does not exist on chain', async () => {
    const now = new Date().toISOString()
    const body = 'gm'
    const sig = await signCreateTd({ postId: 'base-1', body, signedAt: now })
    const deps = buildDeps(buildExecutor(okWhitelist, noPost))

    const out = await createComment(
      { postId: 'base-1', body, signer: TEST_ADDRESS, signature: sig, signedAt: now },
      deps,
    )
    expect(out).toMatchObject({ code: 'PostNotFound' })
  })

  test('rejects when post has been purged (audit M-1)', async () => {
    const now = new Date().toISOString()
    const body = 'gm'
    const sig = await signCreateTd({ postId: 'base-1', body, signedAt: now })
    const deps = buildDeps(buildExecutor(okWhitelist, purgedPost))

    const out = await createComment(
      { postId: 'base-1', body, signer: TEST_ADDRESS, signature: sig, signedAt: now },
      deps,
    )
    expect(out).toMatchObject({ code: 'PostNotFound' })
  })

  test('rate-limits a second create from the same signer within 5s', async () => {
    const now = new Date().toISOString()
    const body = 'gm'
    const sig = await signCreateTd({ postId: 'base-1', body, signedAt: now })
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    poolHandler = buildInsertPoolHandler({
      signer: TEST_ADDRESS,
      postId: 'base-1',
      body,
      signature: sig,
      signedAt: now,
      messageHash: '0x' + 'aa'.repeat(32),
    })

    const first = await createComment(
      { postId: 'base-1', body, signer: TEST_ADDRESS, signature: sig, signedAt: now },
      deps,
    )
    expect(first).toMatchObject({ __typename: 'SubmitCommentSuccess' })

    // Second create immediately after — same signer.
    const now2 = new Date().toISOString()
    const body2 = 'gm again'
    const sig2 = await signCreateTd({ postId: 'base-1', body: body2, signedAt: now2 })

    const second = await createComment(
      { postId: 'base-1', body: body2, signer: TEST_ADDRESS, signature: sig2, signedAt: now2 },
      deps,
    )
    expect(second).toMatchObject({ code: 'RateLimited' })
  })

  // -------------------------------------------------------------------
  // Audit M-5 happy paths
  // -------------------------------------------------------------------

  test('returns DuplicateSubmission when the unique constraint fires (audit M-5/1)', async () => {
    const now = new Date().toISOString()
    const body = 'gm'
    const sig = await signCreateTd({ postId: 'base-1', body, signedAt: now })
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    poolHandler = (text: string) => {
      if (text.startsWith('INSERT INTO comments')) {
        const err = new Error('duplicate key value violates unique constraint "comments_dedupe_idx"') as Error & { code: string }
        err.code = '23505'
        throw err
      }
      return { rows: [] }
    }

    const out = await createComment(
      { postId: 'base-1', body, signer: TEST_ADDRESS, signature: sig, signedAt: now },
      deps,
    )
    expect(out).toMatchObject({ code: 'DuplicateSubmission' })
  })

  test('a second create with a different signedAt (>5s later) succeeds (audit M-5/2)', async () => {
    // First insert — passes through the rate limiter and lands.
    const t1 = new Date().toISOString()
    const sig1 = await signCreateTd({ postId: 'base-1', body: 'gm', signedAt: t1 })
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    let inserted = 0
    poolHandler = (text: string, _values: unknown[]) => {
      if (text.startsWith('INSERT INTO comments')) {
        inserted += 1
        const id = inserted
        return {
          rows: [
            {
              id: String(id),
              post_id: 'base-1',
              chain_slug: 'base',
              signer_address: TEST_ADDRESS,
              body: id === 1 ? 'gm' : 'gm',
              signature: id === 1 ? sig1 : '0x' + 'b'.repeat(130),
              signed_at: new Date(),
              created_at: new Date(),
              last_edited_at: null,
              message_hash: '0x' + (id === 1 ? 'aa' : 'bb').repeat(32),
            },
          ],
        }
      }
      return { rows: [] }
    }

    const first = await createComment(
      { postId: 'base-1', body: 'gm', signer: TEST_ADDRESS, signature: sig1, signedAt: t1 },
      deps,
    )
    expect(first).toMatchObject({ __typename: 'SubmitCommentSuccess' })

    // Second create — same body, but a different signedAt > 5s later
    // and we manually clear the rate-limit because the test isn't here
    // to re-exercise that path. (resetRateLimit() only runs in afterEach.)
    resetRateLimit()
    const t2 = new Date(Date.now() + 6_000).toISOString()
    const sig2 = await signCreateTd({ postId: 'base-1', body: 'gm', signedAt: t2 })

    const second = await createComment(
      { postId: 'base-1', body: 'gm', signer: TEST_ADDRESS, signature: sig2, signedAt: t2 },
      deps,
    )
    expect(second).toMatchObject({ __typename: 'SubmitCommentSuccess' })
  })
})

// ---------------------------------------------------------------------------
// editComment ownership + happy path
// ---------------------------------------------------------------------------

describe('editComment', () => {
  test('rejects edits from a different owner', async () => {
    const now = new Date().toISOString()
    const newBody = 'edited'
    const sig = await signEditTd({ commentId: '1', postId: 'base-1', newBody, signedAt: now })
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    const otherOwner = '0x' + '11'.repeat(20)
    poolHandler = (text: string) => {
      if (text.includes('FROM comments\n       WHERE id = $1')) {
        return {
          rows: [
            {
              id: '1',
              post_id: 'base-1',
              chain_slug: 'base',
              signer_address: otherOwner,
              body: 'old',
              signature: '0x' + 'a'.repeat(130),
              signed_at: new Date(),
              created_at: new Date(),
              last_edited_at: null,
              message_hash: '0x' + 'b'.repeat(64),
            },
          ],
        }
      }
      return { rows: [] }
    }

    const out = await editComment(
      {
        commentId: '1',
        postId: 'base-1',
        newBody,
        signer: TEST_ADDRESS,
        signature: sig,
        signedAt: now,
      },
      deps,
    )
    expect(out).toMatchObject({ code: 'NotCommentOwner' })
  })

  test('returns CommentNotFound for missing rows', async () => {
    const now = new Date().toISOString()
    const newBody = 'edited'
    const sig = await signEditTd({ commentId: '999', postId: 'base-1', newBody, signedAt: now })
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    poolHandler = () => ({ rows: [] })

    const out = await editComment(
      {
        commentId: '999',
        postId: 'base-1',
        newBody,
        signer: TEST_ADDRESS,
        signature: sig,
        signedAt: now,
      },
      deps,
    )
    expect(out).toMatchObject({ code: 'CommentNotFound' })
  })

  test('returns CommentNotFound for malformed commentId (audit L-3)', async () => {
    const now = new Date().toISOString()
    const sig = await signEditTd({ commentId: '1', postId: 'base-1', newBody: 'edited', signedAt: now })
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    const out = await editComment(
      {
        commentId: 'not-a-number',
        postId: 'base-1',
        newBody: 'edited',
        signer: TEST_ADDRESS,
        signature: sig,
        signedAt: now,
      },
      deps,
    )
    expect(out).toMatchObject({ code: 'CommentNotFound' })
  })

  test('successful edit returns updated row with last_edited_at set (audit M-5/3)', async () => {
    const now = new Date().toISOString()
    const newBody = 'gm edited'
    const sig = await signEditTd({ commentId: '1', postId: 'base-1', newBody, signedAt: now })
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    const editedAt = new Date()
    poolHandler = (text: string) => {
      // SELECT existing row.
      if (text.startsWith('SELECT id::text, post_id, chain_slug, signer_address, body, signature,\n            signed_at, created_at, last_edited_at, message_hash\n       FROM comments\n       WHERE id = $1')) {
        return {
          rows: [
            {
              id: '1',
              post_id: 'base-1',
              chain_slug: 'base',
              signer_address: TEST_ADDRESS,
              body: 'gm',
              signature: '0x' + 'a'.repeat(130),
              signed_at: new Date(),
              created_at: new Date(),
              last_edited_at: null,
              message_hash: '0x' + 'b'.repeat(64),
            },
          ],
        }
      }
      // UPDATE returning new row.
      if (text.startsWith('UPDATE comments')) {
        return {
          rows: [
            {
              id: '1',
              post_id: 'base-1',
              chain_slug: 'base',
              signer_address: TEST_ADDRESS,
              body: newBody,
              signature: sig,
              signed_at: new Date(now),
              created_at: new Date(),
              last_edited_at: editedAt,
              message_hash: '0x' + 'c'.repeat(64),
            },
          ],
        }
      }
      return { rows: [] }
    }

    const out = await editComment(
      {
        commentId: '1',
        postId: 'base-1',
        newBody,
        signer: TEST_ADDRESS,
        signature: sig,
        signedAt: now,
      },
      deps,
    )
    expect(out).toMatchObject({ __typename: 'SubmitCommentSuccess' })
    if (out.__typename === 'SubmitCommentSuccess') {
      expect(out.comment.body).toBe(newBody)
      expect(out.comment.lastEditedAt).toBe(editedAt.toISOString())
    }
  })
})

// ---------------------------------------------------------------------------
// deleteComment ownership + happy path
// ---------------------------------------------------------------------------

describe('deleteComment', () => {
  test('rejects deletes from a different owner', async () => {
    const now = new Date().toISOString()
    const sig = await signDeleteTd({ commentId: '1', postId: 'base-1', signedAt: now })
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    const otherOwner = '0x' + '22'.repeat(20)
    poolHandler = (text: string) => {
      if (text.includes('FROM comments\n       WHERE id = $1')) {
        return {
          rows: [
            {
              id: '1',
              post_id: 'base-1',
              chain_slug: 'base',
              signer_address: otherOwner,
              body: 'old',
              signature: '0x' + 'a'.repeat(130),
              signed_at: new Date(),
              created_at: new Date(),
              last_edited_at: null,
              message_hash: '0x' + 'b'.repeat(64),
            },
          ],
        }
      }
      return { rows: [], rowCount: 0 }
    }

    const out = await deleteComment(
      {
        commentId: '1',
        postId: 'base-1',
        signer: TEST_ADDRESS,
        signature: sig,
        signedAt: now,
      },
      deps,
    )
    expect(out).toMatchObject({ code: 'NotCommentOwner' })
  })

  test('returns CommentNotFound for malformed commentId (audit L-3)', async () => {
    const now = new Date().toISOString()
    const sig = await signDeleteTd({ commentId: '1', postId: 'base-1', signedAt: now })
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    const out = await deleteComment(
      {
        commentId: 'not-a-number',
        postId: 'base-1',
        signer: TEST_ADDRESS,
        signature: sig,
        signedAt: now,
      },
      deps,
    )
    expect(out).toMatchObject({ code: 'CommentNotFound' })
  })

  test('successful delete removes the row and returns the id (audit M-5/4)', async () => {
    const now = new Date().toISOString()
    const sig = await signDeleteTd({ commentId: '1', postId: 'base-1', signedAt: now })
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    let deleteCalled = false
    poolHandler = (text: string) => {
      if (text.includes('FROM comments\n       WHERE id = $1')) {
        return {
          rows: [
            {
              id: '1',
              post_id: 'base-1',
              chain_slug: 'base',
              signer_address: TEST_ADDRESS,
              body: 'gm',
              signature: '0x' + 'a'.repeat(130),
              signed_at: new Date(),
              created_at: new Date(),
              last_edited_at: null,
              message_hash: '0x' + 'b'.repeat(64),
            },
          ],
        }
      }
      if (text.startsWith('DELETE FROM comments')) {
        deleteCalled = true
        return { rows: [], rowCount: 1 }
      }
      return { rows: [] }
    }

    const out = await deleteComment(
      {
        commentId: '1',
        postId: 'base-1',
        signer: TEST_ADDRESS,
        signature: sig,
        signedAt: now,
      },
      deps,
    )
    expect(out).toMatchObject({ __typename: 'DeleteCommentSuccess', commentId: '1' })
    expect(deleteCalled).toBe(true)
  })
})
