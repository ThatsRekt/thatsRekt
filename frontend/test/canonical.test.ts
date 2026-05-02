/**
 * Canonical EIP-712 typed-data fingerprint tests.
 *
 * Cross-repo drift sentinel: this file pins the typed-data hashes for a
 * fixed set of fixtures. The mesh backend has a parallel test
 * (`mesh/test/comments.test.ts`) that produces typed-data with the same
 * fixtures and recovers signers via `verifyTypedData` against the same
 * domain + types. Both halves must compute the same hash for a given
 * fixture, otherwise client-side signatures won't verify on the server.
 *
 * If this test starts failing, suspect a contract-shape change:
 *   - Domain fields (name / version / chainId / verifyingContract)
 *   - Type orderings (field order in COMMENT_TYPES)
 *   - Field types (e.g. uint256 vs uint64 for commentId)
 *
 * Bump the domain version on BOTH halves in lockstep. Never patch one
 * side in isolation.
 */
import { describe, expect, test } from 'bun:test'
import { hashTypedData } from 'viem'
import {
  buildCreateTypedData,
  buildEditTypedData,
  buildDeleteTypedData,
  COMMENT_TYPES,
} from '../src/lib/comments'

// Fixed fixtures — must match the mesh test fixtures byte-for-byte.
// `base-1` → chainId 8453, registry proxy `0x390f7b…865936` (legacy
// pre-purge proxy on Base mainnet — see `frontend/src/lib/contracts.ts`).
const FIX_POST_ID = 'base-1'
const FIX_BODY = 'gm'
const FIX_NEW_BODY = 'edited gm'
const FIX_COMMENT_ID = '42'
const FIX_SIGNED_AT = '2026-05-01T00:00:00.000Z'

const EXPECTED_DOMAIN = {
  name: 'thatsRekt',
  version: '1',
  chainId: 8453,
  verifyingContract: '0x390f7b37545CaD278dD3DADC92a20b9f45865936',
} as const

describe('canonical typed-data builders', () => {
  test('domain binds to chain + verifying contract from postId', () => {
    const td = buildCreateTypedData(FIX_POST_ID, FIX_BODY, FIX_SIGNED_AT)
    expect(td.domain).toEqual(EXPECTED_DOMAIN)
    expect(td.primaryType).toBe('CreateComment')
    expect(td.types).toEqual(COMMENT_TYPES)
    expect(td.message).toEqual({
      postId: FIX_POST_ID,
      body: FIX_BODY,
      signedAt: FIX_SIGNED_AT,
    })
  })

  test('edit typed data converts commentId string to bigint', () => {
    const td = buildEditTypedData(
      FIX_COMMENT_ID,
      FIX_POST_ID,
      FIX_NEW_BODY,
      FIX_SIGNED_AT,
    )
    expect(td.primaryType).toBe('EditComment')
    expect(td.message.commentId).toBe(42n)
    expect(td.message.postId).toBe(FIX_POST_ID)
    expect(td.message.newBody).toBe(FIX_NEW_BODY)
    expect(td.message.signedAt).toBe(FIX_SIGNED_AT)
  })

  test('delete typed data has no body field', () => {
    const td = buildDeleteTypedData(FIX_COMMENT_ID, FIX_POST_ID, FIX_SIGNED_AT)
    expect(td.primaryType).toBe('DeleteComment')
    expect(td.message.commentId).toBe(42n)
    expect(td.message.postId).toBe(FIX_POST_ID)
    expect(td.message.signedAt).toBe(FIX_SIGNED_AT)
    expect(td.message).not.toHaveProperty('body')
    expect(td.message).not.toHaveProperty('newBody')
  })
})

describe('canonical typed-data fingerprints', () => {
  // Backend fingerprints must match — see `mesh/test/comments.test.ts`.
  // Recorded values below were produced from the frontend builders
  // against the fixed fixtures + EXPECTED_DOMAIN. The mesh test is
  // expected to compute identical values via viem's hashTypedData.

  test('CreateComment fixture hash is stable', () => {
    const td = buildCreateTypedData(FIX_POST_ID, FIX_BODY, FIX_SIGNED_AT)
    expect(hashTypedData(td)).toBe(
      '0xce3901586bb4ad38ee92f8f57d3edb9867017294fc9ec87563d5737de01a56e0',
    )
  })

  test('EditComment fixture hash is stable', () => {
    const td = buildEditTypedData(
      FIX_COMMENT_ID,
      FIX_POST_ID,
      FIX_NEW_BODY,
      FIX_SIGNED_AT,
    )
    expect(hashTypedData(td)).toBe(
      '0xaeb67df68a48e2211e0cce7c6e426d35493cee6f7db974ca93c914eb1c24ec7f',
    )
  })

  test('DeleteComment fixture hash is stable', () => {
    const td = buildDeleteTypedData(FIX_COMMENT_ID, FIX_POST_ID, FIX_SIGNED_AT)
    expect(hashTypedData(td)).toBe(
      '0x3a2ce2e3ba164f0611ee766434ed1cbc0664ad94c58b0d987e3632ae066136be',
    )
  })
})

describe('chain slug derivation', () => {
  test('rejects unknown chain slugs', () => {
    expect(() =>
      buildCreateTypedData('mars-1', FIX_BODY, FIX_SIGNED_AT),
    ).toThrow(/cannot derive chain slug/i)
  })

  test('matches longer slug first (base-sepolia, not base)', () => {
    // base-sepolia has chainId 84532 + a different verifyingContract;
    // if we accidentally matched `base-` first, the domain would point
    // at Base mainnet which is wrong.
    const td = buildCreateTypedData('base-sepolia-7', FIX_BODY, FIX_SIGNED_AT)
    expect(td.domain.chainId).toBe(84532)
    expect(td.domain.verifyingContract).toBe(
      '0xcd289C9e99D1B8EA6dc0B3fFDED7FEBe26Da0E23',
    )
  })
})
