/**
 * Unit tests for the comments validation pipeline.
 *
 * Strategy: mock the `metaPool` and per-chain executors via bun:test
 * `mock.module`, drive the resolvers with synthesized signed payloads,
 * and verify the discriminated-union outputs.
 *
 * Pure helpers (parsePostId, buildCreateMessage, etc.) are exercised
 * directly without mocks.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { privateKeyToAccount } from 'viem/accounts'
import { createWalletClient, http, keccak256, toHex } from 'viem'
import { mainnet } from 'viem/chains'

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
  buildCreateMessage,
  buildEditMessage,
  buildDeleteMessage,
  parsePostId,
  verifySignature,
  createComment,
  editComment,
  deleteComment,
  resetRateLimit,
  stopRateLimitGc,
} = await import('../src/comments.ts')

import type { ChainEntry } from '../src/chains.ts'
import type { Executor } from '@graphql-tools/utils'
import type { ExecutionResult } from 'graphql'

// --- Fixtures -------------------------------------------------------------

const TEST_CHAINS: readonly ChainEntry[] = Object.freeze([
  {
    chainId: 8453,
    slug: 'base',
    name: 'Base',
    prefix: 'Base_',
    endpoint: 'http://test/base',
  },
  {
    chainId: 84532,
    slug: 'base-sepolia',
    name: 'Base Sepolia',
    prefix: 'BaseSepolia_',
    endpoint: 'http://test/base-sepolia',
  },
])

// Build a per-test signed-comment payload.
const TEST_PRIVKEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVKEY)
const TEST_ADDRESS = TEST_ACCOUNT.address.toLowerCase()

// Wallet client for signing.
const wallet = createWalletClient({
  account: TEST_ACCOUNT,
  chain: mainnet,
  transport: http('http://test'),
})

const signMessage = async (message: string): Promise<`0x${string}`> => {
  return wallet.signMessage({ message })
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
  data: { postById: { id: String(v['id']) } },
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

describe('canonical message format', () => {
  test('create message is stable', () => {
    const msg = buildCreateMessage('base-1', '2026-05-01T00:00:00.000Z', 'gm')
    expect(msg).toBe(
      'thatsRekt comment v1\nop: create\npost: base-1\nsigned_at: 2026-05-01T00:00:00.000Z\nbody: gm',
    )
  })

  test('edit message includes comment id', () => {
    const msg = buildEditMessage('42', 'base-1', '2026-05-01T00:00:00.000Z', 'gm')
    expect(msg).toContain('comment_id: 42')
    expect(msg).toContain('op: edit')
  })

  test('delete message has no body line', () => {
    const msg = buildDeleteMessage('42', 'base-1', '2026-05-01T00:00:00.000Z')
    expect(msg).not.toContain('body:')
    expect(msg).toContain('op: delete')
  })
})

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe('verifySignature', () => {
  test('accepts a valid signature from the claimed signer', async () => {
    const msg = 'hello world'
    const sig = await signMessage(msg)
    const out = await verifySignature({
      message: msg,
      signature: sig,
      signer: TEST_ADDRESS,
    })
    expect('ok' in out && out.ok).toBe(true)
    if ('ok' in out) {
      expect(out.recovered).toBe(TEST_ADDRESS)
    }
  })

  test('rejects when claimed signer is a different address', async () => {
    const msg = 'hello world'
    const sig = await signMessage(msg)
    const wrong = '0x0000000000000000000000000000000000000001'
    const out = await verifySignature({
      message: msg,
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
    const out = await verifySignature({
      message: 'hi',
      signature: '0xdeadbeef',
      signer: TEST_ADDRESS,
    })
    expect(out).toMatchObject({ code: 'InvalidSignature' })
  })
})

// ---------------------------------------------------------------------------
// createComment full pipeline
// ---------------------------------------------------------------------------

describe('createComment', () => {
  test('rejects when signedAt is outside the ±5min window', async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const body = 'gm'
    const msg = buildCreateMessage('base-1', stale, body)
    const sig = await signMessage(msg)
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
    const msg = buildCreateMessage('base-1', now, body)
    const sig = await signMessage(msg)
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
    const msg = buildCreateMessage('base-1', now, body)
    const sig = await signMessage(msg)
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
    const msg = buildCreateMessage('base-1', now, body)
    const sig = await signMessage(msg)
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
    const msg = buildCreateMessage('base-1', now, body)
    const sig = await signMessage(msg)
    const deps = buildDeps(buildExecutor(okWhitelist, noPost))

    const out = await createComment(
      { postId: 'base-1', body, signer: TEST_ADDRESS, signature: sig, signedAt: now },
      deps,
    )
    expect(out).toMatchObject({ code: 'PostNotFound' })
  })

  test('rate-limits a second create from the same signer within 5s', async () => {
    const now = new Date().toISOString()
    const body = 'gm'
    const msg = buildCreateMessage('base-1', now, body)
    const sig = await signMessage(msg)
    const deps = buildDeps(buildExecutor(okWhitelist, okPost))

    // Stub pool responses: dedupe lookup → empty; INSERT → returns one row.
    poolHandler = (text: string) => {
      if (text.startsWith('SELECT body FROM comments')) return { rows: [] }
      if (text.startsWith('INSERT INTO comments')) {
        return {
          rows: [
            {
              id: '1',
              post_id: 'base-1',
              chain_slug: 'base',
              signer_address: TEST_ADDRESS,
              body,
              signature: sig,
              signed_at: new Date(now),
              created_at: new Date(now),
              last_edited_at: null,
              message_hash: keccak256(toHex(msg)),
            },
          ],
        }
      }
      return { rows: [] }
    }

    const first = await createComment(
      { postId: 'base-1', body, signer: TEST_ADDRESS, signature: sig, signedAt: now },
      deps,
    )
    expect(first).toMatchObject({ __typename: 'SubmitCommentSuccess' })

    // Second create immediately after — same signer.
    const now2 = new Date().toISOString()
    const body2 = 'gm again'
    const msg2 = buildCreateMessage('base-1', now2, body2)
    const sig2 = await signMessage(msg2)

    const second = await createComment(
      { postId: 'base-1', body: body2, signer: TEST_ADDRESS, signature: sig2, signedAt: now2 },
      deps,
    )
    expect(second).toMatchObject({ code: 'RateLimited' })
  })
})

// ---------------------------------------------------------------------------
// editComment ownership
// ---------------------------------------------------------------------------

describe('editComment', () => {
  test('rejects edits from a different owner', async () => {
    // The existing comment was authored by some-other-address. We sign
    // with TEST_ADDRESS — must be rejected as NotCommentOwner.
    const now = new Date().toISOString()
    const newBody = 'edited'
    const msg = buildEditMessage('1', 'base-1', now, newBody)
    const sig = await signMessage(msg)
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
    const msg = buildEditMessage('999', 'base-1', now, newBody)
    const sig = await signMessage(msg)
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
})

// ---------------------------------------------------------------------------
// deleteComment ownership
// ---------------------------------------------------------------------------

describe('deleteComment', () => {
  test('rejects deletes from a different owner', async () => {
    const now = new Date().toISOString()
    const msg = buildDeleteMessage('1', 'base-1', now)
    const sig = await signMessage(msg)
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
})
